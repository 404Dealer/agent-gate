import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import YAML from 'yaml';

const readPrivateConfigSource = async (configPath: string): Promise<string> => {
  let handle: FileHandle;
  try {
    handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('Agent-gate config must be an existing regular file, not a symlink');
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error('Agent-gate config must be a regular file, not a symlink');
    }
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error('Agent-gate config must have mode 0600 before OAuth setup');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Agent-gate config must be owned by the OAuth setup user');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

const loadPrivateConfigDocument = async (configPath: string) => {
  const document = YAML.parseDocument(await readPrivateConfigSource(configPath));
  if (document.errors.length > 0) {
    throw new Error('Agent-gate config contains invalid YAML');
  }
  return document;
};

export async function validateProviderConfigTarget(configPath: string): Promise<void> {
  await loadPrivateConfigDocument(configPath);
}

export function validateProviderName(providerName: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(providerName)) {
    throw new Error('Invalid provider name');
  }
}

export function validateMailboxProfileName(profileName: string): void {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(profileName)) {
    throw new Error('Invalid mailbox profile name');
  }
}

export async function updateProviderConfig(
  configPath: string,
  providerName: string,
  providerConfig: Record<string, unknown>,
  setAsDefault: boolean,
  mailboxProfileName?: string
): Promise<void> {
  validateProviderName(providerName);
  if (mailboxProfileName) validateMailboxProfileName(mailboxProfileName);

  const document = await loadPrivateConfigDocument(configPath);
  document.setIn(['providers', providerName], providerConfig);
  if (setAsDefault) {
    document.setIn(['defaults', 'provider'], providerName);
  }
  if (mailboxProfileName) {
    document.setIn(['mailboxProfiles', mailboxProfileName], { provider: providerName });
  }

  const directoryPath = dirname(configPath);
  const tempPath = `${directoryPath}/.config.oauth-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
  let tempHandle: FileHandle | undefined;
  try {
    tempHandle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    await tempHandle.writeFile(document.toString(), 'utf8');
    await tempHandle.chmod(0o600);
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;

    await rename(tempPath, configPath);
    const directoryHandle = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await tempHandle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
