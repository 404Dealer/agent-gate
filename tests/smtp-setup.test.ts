import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { persistSmtpOnboarding } from '../src/oauth/persist.js';
import { parseSmtpSetupArgs } from '../src/smtp/cli-options.js';
import { normalizeGmailAppPassword } from '../src/smtp/normalize.js';
import { verifyGmailSmtpCredentials } from '../src/smtp/verify.js';
import type { SmtpTransportOptions } from '../src/providers/email-smtp.js';

test('production SMTP wrapper enforces TTY, trusted install paths, privilege drop, and health checks', async () => {
  const wrapper = await readFile(new URL('../scripts/smtp-setup.sh', import.meta.url), 'utf8');
  assert.match(wrapper, /if \[\[ ! -t 0 \|\| ! -t 1 \]\]/);
  assert.match(wrapper, /if \[\[ \$EUID -ne 0 \]\]/);
  assert.match(wrapper, /assert_trusted_ancestor_chain/);
  assert.match(wrapper, /resolve_trusted_executable runuser/);
  assert.match(wrapper, /resolve_trusted_executable env/);
  assert.match(wrapper, /resolve_trusted_executable systemctl/);
  assert.match(wrapper, /resolve_trusted_executable sleep/);
  assert.match(wrapper, /"\$RUNUSER_BIN" -u "\$SERVICE_USER" -- "\$ENV_BIN" -i/);
  assert.match(wrapper, /"\$SYSTEMCTL_BIN" restart "\$SERVICE_NAME"/);
  assert.match(wrapper, /"\$SLEEP_BIN" 1/);
  assert.match(wrapper, /dist\/smtp-setup\.js/);
  assert.match(wrapper, /required_consecutive=3/);
  assert.doesNotMatch(wrapper, /--password|--app-password|SMTP_PASSWORD/);

  const installer = await readFile(new URL('../scripts/install-production.sh', import.meta.url), 'utf8');
  assert.match(installer, /"\$INSTALL_DIR\/scripts\/smtp-setup\.sh"/);
});

test('SMTP setup CLI accepts only a Gmail preset and a non-secret config path', () => {
  assert.deepEqual(parseSmtpSetupArgs(['gmail']), {
    provider: 'gmail',
    configPath: '/opt/agent-gate/config/config.yaml'
  });
  assert.deepEqual(parseSmtpSetupArgs(['gmail', '--config', '/safe/config.yaml']), {
    provider: 'gmail',
    configPath: '/safe/config.yaml'
  });
  assert.throws(() => parseSmtpSetupArgs(['custom']), /Provider must be gmail/);
  assert.throws(
    () => parseSmtpSetupArgs(['gmail', '--password', 'must-not-enter-argv']),
    /Unknown option/
  );
});

test('Gmail App Password normalization removes grouping spaces and rejects malformed input', () => {
  assert.equal(normalizeGmailAppPassword('abcd efgh ijkl mnop'), 'abcdefghijklmnop');
  assert.throws(() => normalizeGmailAppPassword('too-short'), /16 ASCII letters or digits/);
  assert.throws(() => normalizeGmailAppPassword('abcd efgh ijkl mno!'), /16 ASCII letters or digits/);
});

test('Gmail SMTP verification uses implicit TLS and fixed secure transport options', async () => {
  let options: SmtpTransportOptions | undefined;
  await verifyGmailSmtpCredentials('owner@gmail.com', 'abcdefghijklmnop', (value) => {
    options = value;
    return { verify: async () => true };
  });

  assert.deepEqual(options, {
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    requireTLS: false,
    auth: { user: 'owner@gmail.com', pass: 'abcdefghijklmnop' },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: { servername: 'smtp.gmail.com', rejectUnauthorized: true }
  });
});

test('Gmail SMTP verification replaces provider errors with a fixed redacted error', async () => {
  await assert.rejects(
    () => verifyGmailSmtpCredentials('owner@gmail.com', 'abcdefghijklmnop', () => ({
      verify: async () => { throw new Error('535 bad password abcdefghijklmnop'); }
    })),
    /^Error: SMTP credential verification failed$/
  );
});

test('SMTP onboarding stores one versioned password and atomically activates safe Gmail metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-smtp-persist-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, `
telegram:
  botToken: "\${PASS:agent-gate/telegram-bot-token}"
  allowedUsers: [2061243435]
watch:
  directory: ./drafts/inbox
providers:
  log:
    type: log-only
defaults:
  provider: log
  timezone: UTC
audit:
  enabled: true
  logFile: ./audit.log
`, { encoding: 'utf8', mode: 0o600 });

    const stored = new Map<string, string>();
    await persistSmtpOnboarding({
      configPath,
      store: { set: async (key: string, value: string) => { stored.set(key, value); } },
      providerName: 'gmail-smtp',
      host: 'smtp.gmail.com',
      port: 465,
      tlsMode: 'implicit',
      username: 'owner@gmail.com',
      password: 'gmail-app-password',
      fromAddress: 'owner@gmail.com',
      displayName: 'Hash Bringer',
      setAsDefault: true
    });

    assert.equal(stored.size, 1);
    const [passwordKey] = [...stored.keys()];
    assert.match(passwordKey, /^agent-gate\/smtp-password-[a-f0-9]{24}$/);
    assert.equal(stored.get(passwordKey), 'gmail-app-password');

    const parsed = YAML.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.deepEqual(parsed.providers['gmail-smtp'], {
      type: 'email-smtp',
      host: 'smtp.gmail.com',
      port: 465,
      tlsMode: 'implicit',
      username: 'owner@gmail.com',
      password: `\${PASS:${passwordKey}}`,
      fromAddress: 'owner@gmail.com',
      displayName: 'Hash Bringer'
    });
    assert.equal(parsed.defaults.provider, 'gmail-smtp');
    assert.equal((await lstat(configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SMTP onboarding rejects an invalid provider name before writing a password', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-smtp-invalid-provider-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'providers: {}\ndefaults:\n  provider: log\n', {
      encoding: 'utf8',
      mode: 0o600
    });
    const writes: string[] = [];

    await assert.rejects(() => persistSmtpOnboarding({
      configPath,
      store: { set: async (key: string) => { writes.push(key); } },
      providerName: 'gmail/smtp',
      host: 'smtp.gmail.com',
      port: 465,
      tlsMode: 'implicit',
      username: 'owner@gmail.com',
      password: 'gmail-app-password',
      fromAddress: 'owner@gmail.com',
      setAsDefault: false
    }), /Invalid provider name/);

    assert.deepEqual(writes, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
