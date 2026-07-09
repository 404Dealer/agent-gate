import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { GmailEmailProvider } from '../src/providers/email-gmail.js';
import type { Draft } from '../src/schema.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sampleDraft = (): Draft => ({
  id: '550e8400-e29b-41d4-a716-446655440000',
  type: 'email',
  status: 'approved',
  createdAt: '2026-07-09T00:00:00.000Z',
  updatedAt: '2026-07-09T00:00:00.000Z',
  source: 'hermes-agent',
  provider: 'gmail',
  payload: {
    from: 'ignored@example.com',
    to: ['recipient@example.com'],
    subject: 'Hello from Gmail',
    body: '<p>Hello <b>world</b></p>',
    cc: ['cc@example.com'],
    bcc: [],
    replyTo: 'reply@example.com'
  },
  metadata: { context: 'unit test', priority: 'normal', tags: [] },
  approval: { approvedBy: '2061243435', approvedAt: '2026-07-09T00:01:00.000Z', telegramMessageId: 1, edits: [] }
});

test('config accepts email-gmail provider credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-gmail-config-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, `
telegram:
  botToken: token
  allowedUsers: [2061243435]
watch:
  directory: ./drafts/inbox
providers:
  gmail:
    type: email-gmail
    clientId: client-id
    clientSecret: client-secret
    refreshToken: refresh-token
    fromAddress: sender@gmail.com
    displayName: Johnny Silverhand
defaults:
  provider: gmail
  timezone: UTC
audit:
  enabled: true
  logFile: ./audit.log
`, 'utf8');

    const config = await loadConfig(configPath);
    assert.equal(config.providers.gmail.type, 'email-gmail');
    assert.equal(config.providers.gmail.fromAddress, 'sender@gmail.com');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('gmail provider refreshes OAuth token and sends a base64url RFC 5322 message', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
      return new Response(JSON.stringify({ id: 'gmail-message-id', threadId: 'thread-id' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('unexpected url', { status: 500 });
  }) as typeof fetch;

  try {
    const provider = new GmailEmailProvider({
      type: 'email-gmail',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      fromAddress: 'sender@gmail.com',
      displayName: 'Johnny Silverhand'
    });

    assert.equal(provider.describeSender(), '"Johnny Silverhand" <sender@gmail.com>');
    const result = await provider.send(sampleDraft());

    assert.equal(result.providerMessageId, 'gmail-message-id');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
    assert(calls[0].init?.signal instanceof AbortSignal);
    assert.equal(calls[1].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    assert(calls[1].init?.signal instanceof AbortSignal);
    assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, 'Bearer access-token');

    const sendBody = JSON.parse(String(calls[1].init?.body)) as { raw: string };
    const decoded = Buffer.from(sendBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    assert.match(decoded, /^From: "Johnny Silverhand" <sender@gmail\.com>$/m);
    assert.match(decoded, /^To: recipient@example\.com$/m);
    assert.match(decoded, /^Cc: cc@example\.com$/m);
    assert.match(decoded, /^Reply-To: reply@example\.com$/m);
    assert.match(decoded, /^Subject: Hello from Gmail$/m);
    assert.match(decoded, /Content-Type: text\/html; charset="UTF-8"/);
    assert.match(decoded, /<p>Hello <b>world<\/b><\/p>/);
    assert.doesNotMatch(decoded, /ignored@example\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('gmail provider rejects token responses without an access token', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ token_type: 'Bearer' }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

  try {
    const provider = new GmailEmailProvider({
      type: 'email-gmail',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      fromAddress: 'sender@gmail.com'
    });

    await assert.rejects(() => provider.send(sampleDraft()), /Gmail token refresh succeeded but no access_token was returned/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
