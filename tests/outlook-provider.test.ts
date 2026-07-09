import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { OutlookEmailProvider } from '../src/providers/email-outlook.js';
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
  provider: 'outlook',
  payload: {
    from: 'ignored@example.com',
    to: ['recipient@example.com'],
    subject: 'Hello from Outlook',
    body: '<p>Hello <b>Graph</b></p>',
    cc: ['cc@example.com'],
    bcc: ['bcc@example.com'],
    replyTo: 'reply@example.com'
  },
  metadata: { context: 'unit test', priority: 'normal', tags: [] },
  approval: { approvedBy: '2061243435', approvedAt: '2026-07-09T00:01:00.000Z', telegramMessageId: 1, edits: [] }
});

test('config accepts email-outlook provider credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-outlook-config-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, `
telegram:
  botToken: token
  allowedUsers: [2061243435]
watch:
  directory: ./drafts/inbox
providers:
  outlook:
    type: email-outlook
    clientId: client-id
    clientSecret: client-secret
    refreshToken: refresh-token
    tenantId: common
    fromAddress: sender@outlook.com
    displayName: Johnny Silverhand
defaults:
  provider: outlook
  timezone: UTC
audit:
  enabled: true
  logFile: ./audit.log
`, 'utf8');

    const config = await loadConfig(configPath);
    assert.equal(config.providers.outlook.type, 'email-outlook');
    assert.equal(config.providers.outlook.fromAddress, 'sender@outlook.com');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('outlook provider refreshes OAuth token and sends a Graph sendMail payload', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('login.microsoftonline.com/common/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url) === 'https://graph.microsoft.com/v1.0/me/sendMail') {
      return new Response('', { status: 202 });
    }
    return new Response('unexpected url', { status: 500 });
  }) as typeof fetch;

  try {
    const provider = new OutlookEmailProvider({
      type: 'email-outlook',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      tenantId: 'common',
      fromAddress: 'sender@outlook.com',
      displayName: 'Johnny Silverhand'
    });

    assert.equal(provider.describeSender(), '"Johnny Silverhand" <sender@outlook.com>');
    const result = await provider.send(sampleDraft());

    assert.equal(result.details, 'Email sent via Outlook / Microsoft Graph');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
    assert.equal(calls[1].url, 'https://graph.microsoft.com/v1.0/me/sendMail');
    assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, 'Bearer access-token');

    const tokenBody = calls[0].init?.body as URLSearchParams;
    assert.equal(tokenBody.get('grant_type'), 'refresh_token');
    assert.equal(tokenBody.get('scope'), 'offline_access Mail.Send');

    const sendBody = JSON.parse(String(calls[1].init?.body)) as {
      message: {
        subject: string;
        body: { contentType: string; content: string };
        toRecipients: Array<{ emailAddress: { address: string } }>;
        ccRecipients: Array<{ emailAddress: { address: string } }>;
        bccRecipients: Array<{ emailAddress: { address: string } }>;
        replyTo: Array<{ emailAddress: { address: string } }>;
      };
      saveToSentItems: boolean;
    };
    assert.equal(sendBody.message.subject, 'Hello from Outlook');
    assert.equal(sendBody.message.body.contentType, 'HTML');
    assert.equal(sendBody.message.body.content, '<p>Hello <b>Graph</b></p>');
    assert.deepEqual(sendBody.message.toRecipients, [{ emailAddress: { address: 'recipient@example.com' } }]);
    assert.deepEqual(sendBody.message.ccRecipients, [{ emailAddress: { address: 'cc@example.com' } }]);
    assert.deepEqual(sendBody.message.bccRecipients, [{ emailAddress: { address: 'bcc@example.com' } }]);
    assert.deepEqual(sendBody.message.replyTo, [{ emailAddress: { address: 'reply@example.com' } }]);
    assert.equal(sendBody.saveToSentItems, true);
    assert.doesNotMatch(String(calls[1].init?.body), /ignored@example\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
