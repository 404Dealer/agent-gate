import test from 'node:test';
import assert from 'node:assert/strict';
import { ZohoEmailProvider } from '../src/providers/email-zoho.js';
import type { Draft } from '../src/schema.js';

const sampleDraft = (): Draft => ({
  id: '550e8400-e29b-41d4-a716-446655440000',
  type: 'email',
  status: 'approved',
  createdAt: '2026-07-09T00:00:00.000Z',
  updatedAt: '2026-07-09T00:00:00.000Z',
  source: 'hermes-agent',
  provider: 'zoho',
  payload: {
    from: 'ignored@example.com',
    to: ['recipient@example.com'],
    subject: 'Hello from Zoho',
    body: '<p>Hello Zoho</p>'
  },
  metadata: { context: 'unit test', priority: 'normal', tags: [] },
  approval: { approvedBy: '2061243435', approvedAt: '2026-07-09T00:01:00.000Z', telegramMessageId: 1, edits: [] }
});

test('zoho provider refreshes and sends only through the configured region', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://accounts.zoho.eu/oauth/v2/token') {
      return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (String(url) === 'https://mail.zoho.eu/api/accounts/123456789/messages') {
      return new Response(JSON.stringify({ data: { messageId: 'message-id' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;

  try {
    const provider = new ZohoEmailProvider({
      type: 'email-zoho',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      region: 'eu',
      accountId: '123456789',
      fromAddress: 'owner@example.eu'
    });
    const firstResult = await provider.send(sampleDraft());
    const secondResult = await provider.send(sampleDraft());
    assert.equal(firstResult.providerMessageId, 'message-id');
    assert.equal(secondResult.providerMessageId, 'message-id');
    assert.equal(calls.length, 3);
    assert.equal(calls.filter((call) => call.url.includes('/oauth/v2/token')).length, 1);
    assert.equal(calls[0].init?.redirect, 'error');
    assert.equal(calls[1].init?.redirect, 'error');
    assert.equal(calls[2].init?.redirect, 'error');
    assert(calls[0].init?.signal instanceof AbortSignal);
    assert(calls[1].init?.signal instanceof AbortSignal);
    assert(calls[2].init?.signal instanceof AbortSignal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('zoho provider refreshes and retries once after a cached-token 401', async () => {
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  let sendCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/oauth/v2/token')) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: `access-${tokenCalls}`, expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    sendCalls += 1;
    const authorization = (init?.headers as Record<string, string>).Authorization;
    if (sendCalls === 1) {
      assert.equal(authorization, 'Zoho-oauthtoken access-1');
      return new Response('', { status: 401 });
    }
    assert.equal(authorization, 'Zoho-oauthtoken access-2');
    return new Response(JSON.stringify({ data: { messageId: 'retried-message' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const provider = new ZohoEmailProvider({
      type: 'email-zoho',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      region: 'eu',
      accountId: '123456789',
      fromAddress: 'owner@example.eu'
    });
    const result = await provider.send(sampleDraft());
    assert.equal(result.providerMessageId, 'retried-message');
    assert.equal(tokenCalls, 2);
    assert.equal(sendCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('zoho provider does not invalidate a newer token on a delayed concurrent 401', async () => {
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  let tokenASends = 0;
  let releaseFirst401!: () => void;
  let releaseSecond401!: () => void;
  let observeTokenB!: () => void;
  const first401Gate = new Promise<void>((resolve) => { releaseFirst401 = resolve; });
  const second401Gate = new Promise<void>((resolve) => { releaseSecond401 = resolve; });
  const tokenBObserved = new Promise<void>((resolve) => { observeTokenB = resolve; });

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/oauth/v2/token')) {
      tokenCalls += 1;
      if (tokenCalls > 2) return new Response('', { status: 429 });
      return new Response(JSON.stringify({ access_token: tokenCalls === 1 ? 'token-a' : 'token-b', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const authorization = (init?.headers as Record<string, string>).Authorization;
    if (authorization === 'Zoho-oauthtoken token-b') {
      observeTokenB();
      return new Response(JSON.stringify({ data: { messageId: 'token-b-message' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    assert.equal(authorization, 'Zoho-oauthtoken token-a');
    tokenASends += 1;
    if (tokenASends === 1) {
      return new Response(JSON.stringify({ data: { messageId: 'primed' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (tokenASends === 2) {
      await first401Gate;
      return new Response('', { status: 401 });
    }
    await second401Gate;
    return new Response('', { status: 401 });
  }) as typeof fetch;

  try {
    const provider = new ZohoEmailProvider({
      type: 'email-zoho',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      region: 'eu',
      accountId: '123456789',
      fromAddress: 'owner@example.eu'
    });
    await provider.send(sampleDraft());
    const first = provider.send(sampleDraft());
    const second = provider.send(sampleDraft());
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirst401();
    await tokenBObserved;
    releaseSecond401();
    await Promise.all([first, second]);
    assert.equal(tokenCalls, 2);
  } finally {
    releaseFirst401?.();
    releaseSecond401?.();
    globalThis.fetch = originalFetch;
  }
});

test('zoho provider redacts malformed token responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('super-secret-refresh-token{', {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })) as typeof fetch;

  try {
    const provider = new ZohoEmailProvider({
      type: 'email-zoho',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      region: 'us',
      accountId: '123456789',
      fromAddress: 'owner@example.com'
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

test('zoho provider rejects token responses without an access token', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ token_type: 'Bearer' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })) as typeof fetch;

  try {
    const provider = new ZohoEmailProvider({
      type: 'email-zoho',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      region: 'us',
      accountId: '123456789',
      fromAddress: 'owner@example.com'
    });
    await assert.rejects(() => provider.send(sampleDraft()), /no access_token was returned/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
