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
    assert(calls[0].init?.signal instanceof AbortSignal);
    assert(calls[1].init?.signal instanceof AbortSignal);
    assert(calls[2].init?.signal instanceof AbortSignal);
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
