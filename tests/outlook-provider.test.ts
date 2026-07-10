import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { OutlookEmailProvider } from '../src/providers/email-outlook.js';
import type { Draft } from '../src/schema.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    assert.equal(config.providers.outlook.clientSecret, undefined);
    assert.equal(config.providers.outlook.refreshTokenKey, undefined);

    const source = await readFile(configPath, 'utf8');
    await writeFile(configPath, source.replace(
      'refreshToken: refresh-token',
      'refreshToken: refresh-token\n    refreshTokenKey: agent-gate/microsoft-refresh-token'
    ), 'utf8');
    await assert.rejects(() => loadConfig(configPath), /exact matching.*PASS/i);
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
    assert.equal(calls[0].init?.redirect, 'error');
    assert(calls[0].init?.signal instanceof AbortSignal);
    assert.equal(calls[1].url, 'https://graph.microsoft.com/v1.0/me/sendMail');
    assert.equal(calls[1].init?.redirect, 'error');
    assert(calls[1].init?.signal instanceof AbortSignal);
    assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, 'Bearer access-token');

    const tokenBody = calls[0].init?.body as URLSearchParams;
    assert.equal(tokenBody.get('grant_type'), 'refresh_token');
    assert.equal(tokenBody.get('scope'), 'offline_access Mail.Send');
    assert.equal(tokenBody.get('client_secret'), null);

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

test('outlook provider persists and reuses rotated refresh tokens', async () => {
  const tokenBodies: URLSearchParams[] = [];
  const stored: Array<{ key: string; value: string }> = [];
  const originalFetch = globalThis.fetch;
  let refreshCount = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('login.microsoftonline.com/common/oauth2/v2.0/token')) {
      tokenBodies.push(init?.body as URLSearchParams);
      refreshCount += 1;
      return new Response(JSON.stringify({
        access_token: `access-${refreshCount}`,
        refresh_token: `rotated-refresh-${refreshCount}`
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
      refreshToken: 'initial-refresh-token',
      refreshTokenKey: 'agent-gate/microsoft-refresh-token',
      tenantId: 'common',
      fromAddress: 'sender@outlook.com'
    }, {
      set: async (key: string, value: string) => { stored.push({ key, value }); }
    });

    await provider.send(sampleDraft());
    await provider.send(sampleDraft());

    assert.equal(tokenBodies[0].get('refresh_token'), 'initial-refresh-token');
    assert.equal(tokenBodies[1].get('refresh_token'), 'rotated-refresh-1');
    assert.deepEqual(stored, [
      { key: 'agent-gate/microsoft-refresh-token', value: 'rotated-refresh-1' },
      { key: 'agent-gate/microsoft-refresh-token', value: 'rotated-refresh-2' }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('outlook provider preserves legacy in-memory rotation when no persistence key is configured', async () => {
  const originalFetch = globalThis.fetch;
  const tokenBodies: URLSearchParams[] = [];
  let refreshCount = 0;
  let graphCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/oauth2/v2.0/token')) {
      tokenBodies.push(init?.body as URLSearchParams);
      refreshCount += 1;
      return new Response(JSON.stringify({
        access_token: `access-${refreshCount}`,
        refresh_token: `rotated-refresh-${refreshCount}`
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    graphCalls += 1;
    return new Response('', { status: 202 });
  }) as typeof fetch;

  try {
    const provider = new OutlookEmailProvider({
      type: 'email-outlook',
      clientId: 'client-id',
      refreshToken: 'initial-refresh-token',
      tenantId: 'common',
      fromAddress: 'sender@outlook.com'
    });

    await provider.send(sampleDraft());
    await provider.send(sampleDraft());
    assert.equal(graphCalls, 2);
    assert.equal(tokenBodies[0].get('refresh_token'), 'initial-refresh-token');
    assert.equal(tokenBodies[1].get('refresh_token'), 'rotated-refresh-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('outlook provider serializes concurrent refresh-token rotation', async () => {
  const originalFetch = globalThis.fetch;
  let releaseTokenResponse!: () => void;
  const tokenGate = new Promise<void>((resolve) => { releaseTokenResponse = resolve; });
  let tokenCalls = 0;
  let graphCalls = 0;
  const stored: Array<{ key: string; value: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes('/oauth2/v2.0/token')) {
      tokenCalls += 1;
      await tokenGate;
      return new Response(JSON.stringify({
        access_token: 'shared-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    graphCalls += 1;
    return new Response('', { status: 202 });
  }) as typeof fetch;

  try {
    const provider = new OutlookEmailProvider({
      type: 'email-outlook',
      clientId: 'client-id',
      refreshToken: 'initial-refresh-token',
      refreshTokenKey: 'agent-gate/microsoft-refresh-token-version',
      tenantId: 'common',
      fromAddress: 'sender@outlook.com'
    }, {
      set: async (key: string, value: string) => { stored.push({ key, value }); }
    });

    const first = provider.send(sampleDraft());
    const second = provider.send(sampleDraft());
    await new Promise((resolve) => setImmediate(resolve));
    releaseTokenResponse();
    await Promise.all([first, second]);

    assert.equal(tokenCalls, 1);
    assert.equal(graphCalls, 2);
    assert.deepEqual(stored, [{
      key: 'agent-gate/microsoft-refresh-token-version',
      value: 'rotated-refresh-token'
    }]);
  } finally {
    releaseTokenResponse?.();
    globalThis.fetch = originalFetch;
  }
});

test('outlook provider refreshes and retries once after a cached-token 401', async () => {
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  let graphCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/oauth2/v2.0/token')) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: `access-${tokenCalls}`, expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    graphCalls += 1;
    const authorization = (init?.headers as Record<string, string>).Authorization;
    if (graphCalls === 1) {
      assert.equal(authorization, 'Bearer access-1');
      return new Response('', { status: 401 });
    }
    assert.equal(authorization, 'Bearer access-2');
    return new Response('', { status: 202 });
  }) as typeof fetch;

  try {
    const provider = new OutlookEmailProvider({
      type: 'email-outlook',
      clientId: 'client-id',
      refreshToken: 'refresh-token',
      tenantId: 'common',
      fromAddress: 'sender@outlook.com'
    });
    await provider.send(sampleDraft());
    assert.equal(tokenCalls, 2);
    assert.equal(graphCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('outlook provider redacts malformed token responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('super-secret-refresh-token{', {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })) as typeof fetch;

  try {
    const provider = new OutlookEmailProvider({
      type: 'email-outlook',
      clientId: 'client-id',
      refreshToken: 'refresh-token',
      tenantId: 'common',
      fromAddress: 'sender@outlook.com'
    });
    await assert.rejects(() => provider.send(sampleDraft()), (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /invalid JSON/);
      assert.doesNotMatch(error.message, /super-secret/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('outlook provider rejects token responses without an access token', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ token_type: 'Bearer' }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

  try {
    const provider = new OutlookEmailProvider({
      type: 'email-outlook',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      tenantId: 'common',
      fromAddress: 'sender@outlook.com'
    });

    await assert.rejects(() => provider.send(sampleDraft()), /Outlook token refresh succeeded but no access_token was returned/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
