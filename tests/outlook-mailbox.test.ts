import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderConfig } from '../src/config.js';
import { OutlookMailboxAdapter, type OutlookGraphClient } from '../src/mailbox-broker/outlook-mailbox.js';
import { decodeInboxReference } from '../src/mailbox-broker/reference.js';
import { DraftSchema } from '../src/schema.js';

const providerConfig: Extract<ProviderConfig, { type: 'email-outlook' }> = {
  type: 'email-outlook',
  clientId: 'client-id',
  refreshToken: 'refresh-token',
  tenantId: 'common',
  fromAddress: 'work@outlook.com',
  mailboxAccess: true
};

test('Outlook list uses fixed Inbox endpoint and immutable message IDs', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const graph: OutlookGraphClient = {
    request: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        value: [{
          id: 'AAMkImmutableId-1',
          isRead: false,
          flag: { flagStatus: 'flagged' },
          from: { emailAddress: { name: 'Example Sender', address: 'sender@example.com' } },
          subject: 'Hello',
          receivedDateTime: '2026-07-10T00:00:00Z',
          hasAttachments: false
        }, {
          id: 'AAMkImmutableId-read',
          isRead: true,
          from: { emailAddress: { address: 'read@example.com' } },
          subject: 'Already read',
          receivedDateTime: '2026-07-09T00:00:00Z',
          hasAttachments: false
        }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  };
  const adapter = new OutlookMailboxAdapter('work', 'outlook-work', providerConfig, graph);

  const result = await adapter.list(true, 7);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages\?/);
  assert.match(calls[0].url, /%24top=200/);
  assert.doesNotMatch(calls[0].url, /%24filter=/);
  assert.equal((calls[0].init?.headers as Record<string, string>).Prefer, 'IdType="ImmutableId"');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].unread, true);
  assert.equal(result.items[0].flagged, true);
  assert.deepEqual(decodeInboxReference(result.items[0].ref), {
    v: 2,
    profile: 'work',
    backend: 'outlook',
    folder: 'inbox',
    messageId: 'AAMkImmutableId-1'
  });
});

test('Outlook references fail closed after a message leaves Inbox', async () => {
  let requestedUrl = '';
  const graph: OutlookGraphClient = {
    request: async (url: string) => {
      requestedUrl = url;
      return new Response('', { status: 404 });
    }
  };
  const adapter = new OutlookMailboxAdapter('work', 'outlook-work', providerConfig, graph);
  const ref = Buffer.from(JSON.stringify({
    v: 2,
    profile: 'work',
    backend: 'outlook',
    folder: 'inbox',
    messageId: 'AAMkImmutableId-1'
  }), 'utf8').toString('base64url');

  await assert.rejects(() => adapter.read(ref), /Outlook mailbox operation failed/);
  assert.equal(
    requestedUrl,
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/AAMkImmutableId-1?$select=id,isRead,flag,from,toRecipients,ccRecipients,subject,receivedDateTime,body,hasAttachments'
  );
});

test('Outlook mark-read patches and verifies only the exact immutable message', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const graph: OutlookGraphClient = {
    request: async (url, init) => {
      calls.push({ url, init });
      if (init?.method === 'PATCH') return new Response('', { status: 200 });
      return new Response(JSON.stringify({ id: 'AAMkImmutableId-1', isRead: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  };
  const adapter = new OutlookMailboxAdapter('work', 'outlook-work', providerConfig, graph);
  const reference = Buffer.from(JSON.stringify({
    v: 2,
    profile: 'work',
    backend: 'outlook',
    folder: 'inbox',
    messageId: 'AAMkImmutableId-1'
  }), 'utf8').toString('base64url');

  const result = await adapter.markRead([reference]);

  assert.deepEqual(result, { outcome: 'applied', requested: 1, verified: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/AAMkImmutableId-1');
  assert.equal(calls[0].init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { isRead: true });
  assert.equal(calls[1].url, 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/AAMkImmutableId-1?$select=id,isRead');
});

test('Outlook Trash uses only the fixed move endpoint and deleteditems destination', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const graph: OutlookGraphClient = {
    request: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/move')) return new Response(JSON.stringify({
        id: 'AAMkImmutableId-1',
        from: { emailAddress: { address: 'sender@example.com' } },
        subject: 'Offer',
        receivedDateTime: '2026-07-10T00:00:00Z'
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({
        id: 'AAMkImmutableId-1',
        from: { emailAddress: { address: 'sender@example.com' } },
        subject: 'Offer',
        receivedDateTime: '2026-07-10T00:00:00Z'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  };
  const adapter = new OutlookMailboxAdapter('work', 'outlook-work', providerConfig, graph);
  const ref = Buffer.from(JSON.stringify({ v: 2, profile: 'work', backend: 'outlook', folder: 'inbox', messageId: 'AAMkImmutableId-1' }), 'utf8').toString('base64url');
  const draft = DraftSchema.parse({
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'mailbox-trash',
    status: 'pending',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    source: 'test',
    provider: 'outlook-work',
    payload: { refs: [ref] }
  });
  const snapshot = await adapter.prepareTrash(draft);
  const result = await adapter.executeTrash(snapshot);
  assert.equal(result.outcome, 'moved');
  assert.equal(calls[1].url, 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/AAMkImmutableId-1/move');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { destinationId: 'deleteditems' });
});

test('Outlook unsubscribe uses only authoritative internet message headers', async () => {
  const graph: OutlookGraphClient = {
    request: async () => new Response(JSON.stringify({
      id: 'AAMkImmutableId-1',
      from: { emailAddress: { address: 'sender@example.com' } },
      subject: 'Newsletter',
      receivedDateTime: '2026-07-10T00:00:00Z',
      internetMessageHeaders: [
        { name: 'List-Unsubscribe', value: '<mailto:unsubscribe@example.com?subject=remove>' },
        { name: 'X-Untrusted-Body-Link', value: 'https://example.com/not-used' }
      ]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  };
  const adapter = new OutlookMailboxAdapter('work', 'outlook-work', providerConfig, graph);
  const ref = Buffer.from(JSON.stringify({ v: 2, profile: 'work', backend: 'outlook', folder: 'inbox', messageId: 'AAMkImmutableId-1' }), 'utf8').toString('base64url');
  const draft = DraftSchema.parse({
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'mailbox-unsubscribe',
    status: 'pending',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    source: 'test',
    provider: 'outlook-work',
    payload: { ref }
  });
  const snapshot = await adapter.prepareUnsubscribe(draft);
  assert.equal(snapshot.method, 'rfc2369-mailto');
  if (snapshot.method !== 'rfc2369-mailto') throw new Error('unexpected method');
  assert.equal(snapshot.recipient, 'unsubscribe@example.com');
  assert.equal(snapshot.subject, 'remove');
});

test('Outlook unsubscribe rejects header values containing CR or LF', async () => {
  const graph: OutlookGraphClient = {
    request: async () => new Response(JSON.stringify({
      id: 'AAMkImmutableId-1',
      from: { emailAddress: { address: 'sender@example.com' } },
      subject: 'Newsletter',
      receivedDateTime: '2026-07-10T00:00:00Z',
      internetMessageHeaders: [{
        name: 'List-Unsubscribe',
        value: '<https://example.com/unsubscribe>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click'
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  };
  const adapter = new OutlookMailboxAdapter('work', 'outlook-work', providerConfig, graph);
  const ref = Buffer.from(JSON.stringify({
    v: 2,
    profile: 'work',
    backend: 'outlook',
    folder: 'inbox',
    messageId: 'AAMkImmutableId-1'
  }), 'utf8').toString('base64url');
  await assert.rejects(() => adapter.prepareUnsubscribeReference(ref));
});
