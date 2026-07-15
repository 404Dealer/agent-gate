import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const PASS_REFERENCE = /^\$\{PASS:(nightdrop\/[a-z0-9][a-z0-9-]{0,127})\}$/;
const GmailProviderSchema = z.object({
  type: z.literal('email-smtp'),
  host: z.literal('smtp.gmail.com'),
  port: z.literal(465),
  tlsMode: z.literal('implicit'),
  username: z.string().trim().email(),
  password: z.string().min(1),
  fromAddress: z.string().trim().email()
}).passthrough();

export interface GmailCleanupCredentials {
  username: string;
  password: string;
}

const assertPrivateConfig = async (configPath: string): Promise<void> => {
  if (!isAbsolute(configPath)) throw new Error('Mailbox cleanup config path must be absolute');
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) {
    throw new Error('Mailbox cleanup must run as the isolated nightdrop user');
  }
  const stat = await lstat(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Nightdrop config must be a regular file, not a symlink');
  }
  if (stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    throw new Error('Nightdrop config must be owned by the cleanup user with mode 0600');
  }
};

const readPinnedSecret = async (
  passExecutable: string,
  key: string,
  env: NodeJS.ProcessEnv
): Promise<string> => {
  try {
    const { stdout } = await execFileAsync(passExecutable, ['show', key], {
      encoding: 'utf8',
      env,
      timeout: 5_000,
      maxBuffer: 4_096,
      windowsHide: true
    });
    const password = stdout.trim();
    if (!/^[A-Za-z0-9]{16}$/.test(password)) {
      throw new Error('invalid value');
    }
    return password;
  } catch {
    throw new Error('Could not read the isolated Gmail App Password');
  }
};

export async function loadGmailCleanupCredentials(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<GmailCleanupCredentials> {
  await assertPrivateConfig(configPath);
  const passExecutable = env.NIGHTDROP_PASS_BIN;
  if (!passExecutable || !isAbsolute(passExecutable)) {
    throw new Error('Mailbox cleanup requires a trusted absolute pass executable');
  }

  let document: unknown;
  try {
    document = YAML.parse(await readFile(configPath, 'utf8'));
  } catch {
    throw new Error('Could not read the private Nightdrop configuration');
  }
  const root = z.object({ providers: z.record(z.unknown()) }).safeParse(document);
  if (!root.success) throw new Error('Nightdrop configuration is missing providers');
  const parsed = GmailProviderSchema.safeParse(root.data.providers['gmail-smtp']);
  if (!parsed.success) throw new Error('Configured gmail-smtp provider is not eligible for mailbox cleanup');

  const username = parsed.data.username;
  if (username.toLowerCase() !== parsed.data.fromAddress.toLowerCase()) {
    throw new Error('Mailbox cleanup requires the authenticated Gmail sender identity');
  }
  const reference = PASS_REFERENCE.exec(parsed.data.password);
  if (!reference) {
    throw new Error('Gmail App Password must remain an isolated pass reference');
  }

  const password = await readPinnedSecret(passExecutable, reference[1], env);
  return { username, password };
}
