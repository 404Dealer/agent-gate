import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { persistSmtpOnboarding } from '../src/oauth/persist.js';
import { parseSmtpSetupArgs } from '../src/smtp/cli-options.js';
import { normalizeGmailAppPassword } from '../src/smtp/normalize.js';
import { verifyGmailSmtpCredentials } from '../src/smtp/verify.js';
import { resolveSmtpPassExecutable } from '../src/smtp-setup.js';
import type { SmtpTransportOptions } from '../src/providers/email-smtp.js';

test('production SMTP wrapper enforces TTY, trusted install paths, privilege drop, and health checks', async () => {
  const wrapper = await readFile(new URL('../scripts/smtp-setup.sh', import.meta.url), 'utf8');
  assert.match(wrapper, /^#!\/bin\/bash$/m);
  assert.match(wrapper, /\/usr\/bin\/dirname -- "\$SCRIPT_PATH"/);
  assert.match(wrapper, /if \[\[ ! -t 0 \|\| ! -t 1 \]\]/);
  assert.match(wrapper, /if \[\[ \$EUID -ne 0 \]\]/);
  assert.match(wrapper, /assert_trusted_ancestor_chain/);
  assert.match(wrapper, /validate_trusted_path/);
  assert.match(wrapper, /resolve_trusted_executable runuser/);
  assert.match(wrapper, /resolve_trusted_executable pass/);
  assert.match(wrapper, /AGENT_GATE_PASS_BIN="\$PASS_BIN"/);
  assert(wrapper.indexOf('validate_trusted_path') < wrapper.indexOf('"$RUNUSER_BIN" -u'));
  assert.match(wrapper, /resolve_trusted_executable env/);
  assert.match(wrapper, /resolve_trusted_executable systemctl/);
  assert.match(wrapper, /resolve_trusted_executable sleep/);
  assert.match(wrapper, /"\$RUNUSER_BIN" -u "\$SERVICE_USER" -- "\$ENV_BIN" -i/);
  assert.match(wrapper, /"\$SYSTEMCTL_BIN" restart "\$SERVICE_NAME"/);
  assert.match(wrapper, /"\$SLEEP_BIN" 1/);
  assert.match(wrapper, /dist\/smtp-setup\.js/);
  assert.match(wrapper, /required_consecutive=3/);
  assert.match(wrapper, /App Password was not printed or exposed to Hermes/);
  assert.doesNotMatch(wrapper, /never exposed to the invoking user/);
  assert.doesNotMatch(wrapper, /--password|--app-password|SMTP_PASSWORD/);

  const installer = await readFile(new URL('../scripts/install-production.sh', import.meta.url), 'utf8');
  assert.match(installer, /"\$INSTALL_DIR\/scripts\/smtp-setup\.sh"/);
  assert.match(installer, /--exclude \/\.hermes\//);
  assert.match(installer, /resolve_trusted_executable pass/);
  assert.match(installer, /Environment=AGENT_GATE_PASS_BIN=\$PASS_BIN/);

  const configSource = await readFile(new URL('../src/config.ts', import.meta.url), 'utf8');
  assert.match(configSource, /execFileSync\(passExecutable, \['show', key\]/);
  assert.doesNotMatch(configSource, /execSync\(`pass show/);
});

test('trusted PATH validation rejects an attacker-writable executable directory before child launch', async () => {
  const wrapper = await readFile(new URL('../scripts/smtp-setup.sh', import.meta.url), 'utf8');
  const functionSource = wrapper.match(/validate_trusted_path\(\) \{[\s\S]*?\n\}/)?.[0];
  assert(functionSource, 'validate_trusted_path function not found');
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-untrusted-path-'));
  try {
    await chmod(dir, 0o777);
    const result = spawnSync('/bin/bash', ['-c', [
      'set -euo pipefail',
      functionSource,
      `TRUSTED_PATH=${JSON.stringify(dir)}`,
      'validate_trusted_path'
    ].join('\n')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing untrusted executable path directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SMTP setup requires an absolute pass executable selected by the trusted wrapper', async () => {
  assert.equal(resolveSmtpPassExecutable({ AGENT_GATE_PASS_BIN: '/usr/bin/pass' }), '/usr/bin/pass');
  assert.throws(() => resolveSmtpPassExecutable({}), /trusted absolute pass executable/);
  assert.throws(
    () => resolveSmtpPassExecutable({ AGENT_GATE_PASS_BIN: 'pass' }),
    /trusted absolute pass executable/
  );

  const source = await readFile(new URL('../src/smtp-setup.ts', import.meta.url), 'utf8');
  assert.match(source, /new PassSecretStore\(\{ executable: passExecutable \}\)/);
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
