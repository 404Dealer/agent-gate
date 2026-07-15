import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createProvider } from '../src/providers/index.js';
import { SmtpEmailProvider, type SmtpMessage, type SmtpTransportOptions } from '../src/providers/email-smtp.js';
import type { Draft } from '../src/schema.js';

const sampleDraft = (): Draft => ({
  id: '550e8400-e29b-41d4-a716-446655440000',
  type: 'email',
  status: 'approved',
  createdAt: '2026-07-10T00:00:00.000Z',
  updatedAt: '2026-07-10T00:00:00.000Z',
  source: 'hermes-agent',
  provider: 'gmail-smtp',
  payload: {
    from: 'ignored@example.com',
    to: ['recipient@example.com'],
    cc: ['cc@example.com'],
    bcc: ['bcc@example.com'],
    replyTo: 'reply@example.com',
    subject: 'SMTP test',
    body: '<p>Approved body</p>'
  },
  metadata: { context: 'unit test', priority: 'normal', tags: [] },
  approval: {
    approvedBy: '2061243435',
    approvedAt: '2026-07-10T00:01:00.000Z',
    telegramMessageId: 1,
    edits: []
  }
});

test('config loads an authenticated TLS SMTP provider and the factory creates it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-smtp-config-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, `
telegram:
  botToken: token
  allowedUsers: [2061243435]
watch:
  directory: ./drafts/inbox
providers:
  gmail-smtp:
    type: email-smtp
    host: smtp.gmail.com
    port: 465
    tlsMode: implicit
    username: " sender@gmail.com "
    password: app-password
    fromAddress: sender@gmail.com
    displayName: Johnny Silverhand
defaults:
  provider: gmail-smtp
  timezone: UTC
audit:
  enabled: true
  logFile: ./audit.log
`, 'utf8');

    const config = await loadConfig(configPath);
    const smtpConfig = config.providers['gmail-smtp'];
    assert.equal(smtpConfig.type, 'email-smtp');
    assert.equal(smtpConfig.host, 'smtp.gmail.com');
    assert.equal(smtpConfig.port, 465);
    assert.equal(smtpConfig.tlsMode, 'implicit');
    assert.equal(smtpConfig.username, 'sender@gmail.com');
    assert(createProvider(smtpConfig) instanceof SmtpEmailProvider);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('smtp provider sends the approved payload with the configured sender over implicit TLS', async () => {
  let transportOptions: Record<string, unknown> | undefined;
  let sentMessage: Record<string, unknown> | undefined;
  const transportFactory = (options: SmtpTransportOptions) => {
    transportOptions = options;
    return {
      sendMail: async (message: SmtpMessage) => {
        sentMessage = message;
        return {
          messageId: '<smtp-message-id@example.com>',
          accepted: ['recipient@example.com', 'cc@example.com', 'bcc@example.com'],
          rejected: []
        };
      }
    };
  };

  const provider = new SmtpEmailProvider({
    type: 'email-smtp',
    host: 'smtp.gmail.com',
    port: 465,
    tlsMode: 'implicit',
    username: 'sender@gmail.com',
    password: 'app-password',
    fromAddress: 'sender@gmail.com',
    displayName: 'Johnny Silverhand'
  }, transportFactory);

  assert.equal(provider.describeSender(), '"Johnny Silverhand" <sender@gmail.com>');
  const result = await provider.send(sampleDraft());

  assert.deepEqual(transportOptions, {
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    requireTLS: false,
    auth: { user: 'sender@gmail.com', pass: 'app-password' },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: { servername: 'smtp.gmail.com', rejectUnauthorized: true }
  });
  assert.deepEqual(sentMessage, {
    from: '"Johnny Silverhand" <sender@gmail.com>',
    to: ['recipient@example.com'],
    cc: ['cc@example.com'],
    bcc: ['bcc@example.com'],
    replyTo: 'reply@example.com',
    subject: 'SMTP test',
    html: '<p>Approved body</p>'
  });
  assert.deepEqual(result, {
    providerMessageId: '<smtp-message-id@example.com>',
    details: 'Email accepted by SMTP for 3 recipients'
  });
  assert.doesNotMatch(JSON.stringify(sentMessage), /ignored@example\.com/);
});

test('smtp provider drops a server-controlled message ID containing control characters', async () => {
  const provider = new SmtpEmailProvider({
    type: 'email-smtp',
    host: 'smtp.gmail.com',
    port: 465,
    tlsMode: 'implicit',
    username: 'sender@gmail.com',
    password: 'app-password',
    fromAddress: 'sender@gmail.com'
  }, () => ({
    sendMail: async () => ({
      messageId: '<safe@example.com>\r\nInjected: secret',
      accepted: ['recipient@example.com'],
      rejected: []
    })
  }));

  const result = await provider.send(sampleDraft());
  assert.equal(result.providerMessageId, undefined);
  assert.equal(result.details, 'Email accepted by SMTP for 1 recipient');
});

test('config rejects an SMTP host containing URL or whitespace syntax', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-smtp-invalid-host-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, `
telegram:
  botToken: token
  allowedUsers: [2061243435]
watch:
  directory: ./drafts/inbox
providers:
  smtp:
    type: email-smtp
    host: "smtp.gmail.com/path with-space"
    port: 465
    tlsMode: implicit
    username: sender@gmail.com
    password: app-password
    fromAddress: sender@gmail.com
defaults:
  provider: smtp
  timezone: UTC
audit:
  enabled: true
  logFile: ./audit.log
`, 'utf8');

    await assert.rejects(() => loadConfig(configPath), /Invalid SMTP host/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config requires explicit operator opt-in when SMTP sender differs from authenticated username', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-smtp-alias-'));
  try {
    const configPath = join(dir, 'config.yaml');
    const render = (allowAlias: boolean): string => `
telegram:
  botToken: token
  allowedUsers: [2061243435]
watch:
  directory: ./drafts/inbox
providers:
  smtp:
    type: email-smtp
    host: smtp.example.com
    port: 465
    tlsMode: implicit
    username: authenticated@example.com
    password: app-password
    fromAddress: alias@example.com
${allowAlias ? '    allowFromAlias: true\n' : ''}defaults:
  provider: smtp
  timezone: UTC
audit:
  enabled: true
  logFile: ./audit.log
`;
    await writeFile(configPath, render(false), 'utf8');
    await assert.rejects(() => loadConfig(configPath), /allowFromAlias/);

    await writeFile(configPath, render(true), 'utf8');
    const config = await loadConfig(configPath);
    assert.equal(config.providers.smtp.type, 'email-smtp');
    if (config.providers.smtp.type === 'email-smtp') {
      assert.equal(config.providers.smtp.allowFromAlias, true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('smtp provider requires STARTTLS when configured', async () => {
  let transportOptions: SmtpTransportOptions | undefined;
  const provider = new SmtpEmailProvider({
    type: 'email-smtp',
    host: 'smtp.example.com',
    port: 587,
    tlsMode: 'starttls',
    username: 'sender@example.com',
    password: 'app-password',
    fromAddress: 'sender@example.com'
  }, (options) => {
    transportOptions = options;
    return {
      sendMail: async () => ({ accepted: ['recipient@example.com'], rejected: [] })
    };
  });

  await provider.send(sampleDraft());
  assert.equal(transportOptions?.secure, false);
  assert.equal(transportOptions?.requireTLS, true);
  assert.deepEqual(transportOptions?.tls, {
    servername: 'smtp.example.com',
    rejectUnauthorized: true
  });
});

test('smtp provider omits invalid SNI for an IP host while keeping certificate verification', () => {
  let transportOptions: SmtpTransportOptions | undefined;
  new SmtpEmailProvider({
    type: 'email-smtp',
    host: '192.0.2.1',
    port: 465,
    tlsMode: 'implicit',
    username: 'sender@example.com',
    password: 'app-password',
    fromAddress: 'sender@example.com'
  }, (options) => {
    transportOptions = options;
    return { sendMail: async () => ({ accepted: ['recipient@example.com'] }) };
  });

  assert.deepEqual(transportOptions?.tls, { rejectUnauthorized: true });
});

test('smtp provider replaces transport failures with a fixed redacted error', async () => {
  const provider = new SmtpEmailProvider({
    type: 'email-smtp',
    host: 'smtp.gmail.com',
    port: 465,
    tlsMode: 'implicit',
    username: 'sender@gmail.com',
    password: 'super-secret-app-password',
    fromAddress: 'sender@gmail.com'
  }, () => ({
    sendMail: async () => {
      throw new Error('535 bad password super-secret-app-password from remote');
    }
  }));

  await assert.rejects(() => provider.send(sampleDraft()), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.message, 'SMTP send failed');
    assert.doesNotMatch(error.message, /secret|535|remote/i);
    return true;
  });
});

test('smtp provider returns a structured partial outcome to prevent duplicate retry', async () => {
  const provider = new SmtpEmailProvider({
    type: 'email-smtp',
    host: 'smtp.gmail.com',
    port: 465,
    tlsMode: 'implicit',
    username: 'sender@gmail.com',
    password: 'app-password',
    fromAddress: 'sender@gmail.com'
  }, () => ({
    sendMail: async () => ({
      messageId: '<partial@example.com>',
      accepted: ['recipient@example.com'],
      rejected: [
        'cc@example.com',
        'server-injected@example.net',
        { address: 'bcc@example.com' },
        42
      ]
    })
  }));

  assert.deepEqual(await provider.send(sampleDraft()), {
    outcome: 'partial',
    providerMessageId: '<partial@example.com>',
    details: 'Email accepted by SMTP for 1 recipient; 4 rejected',
    acceptedCount: 1,
    rejectedCount: 4,
    rejectedRecipients: ['cc@example.com']
  });
});

test('smtp provider fails with a fixed error when no recipient is accepted', async () => {
  const provider = new SmtpEmailProvider({
    type: 'email-smtp',
    host: 'smtp.gmail.com',
    port: 465,
    tlsMode: 'implicit',
    username: 'sender@gmail.com',
    password: 'app-password',
    fromAddress: 'sender@gmail.com'
  }, () => ({
    sendMail: async () => ({ accepted: [], rejected: ['recipient@example.com'] })
  }));

  await assert.rejects(() => provider.send(sampleDraft()), /^Error: SMTP send failed$/);
});
