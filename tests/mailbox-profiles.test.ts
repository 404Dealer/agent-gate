import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentGateConfig } from '../src/config.js';
import { parseMailboxClientArgs } from '../src/mailbox-client.js';
import { mailboxProfilesFromConfig } from '../src/mailbox-broker/profiles.js';
import { decodeInboxReference, encodeInboxReference, encodeOutlookInboxReference } from '../src/mailbox-broker/reference.js';
import { buildMailboxTrashPreview, buildMailboxUnsubscribePreview } from '../src/bot.js';
import { GmailInboxBroker } from '../src/mailbox-broker/gmail-inbox.js';
import { GmailMailboxTrashService } from '../src/mailbox-broker/gmail-trash.js';
import { GmailUnsubscribeService } from '../src/mailbox-broker/gmail-unsubscribe.js';
import { MailboxBrokerServer } from '../src/mailbox-broker/server.js';
import { MailboxRequestSchema, MAX_REQUEST_BYTES } from '../src/mailbox-broker/protocol.js';
import type { MailboxAdapter } from '../src/mailbox-broker/adapter.js';
import { DraftSchema } from '../src/schema.js';

const smtpProvider = (address: string) => ({
  type: 'email-smtp' as const,
  host: 'smtp.gmail.com',
  port: 465,
  tlsMode: 'implicit' as const,
  username: address,
  password: `password-for-${address}`,
  fromAddress: address,
  displayName: address,
  allowFromAlias: false
});

const outlookProvider = (address: string, mailboxAccess = true) => ({
  type: 'email-outlook' as const,
  clientId: `client-${address}`,
  refreshToken: `refresh-${address}`,
  tenantId: 'common',
  fromAddress: address,
  mailboxAccess
});

const configWithProfiles = (): AgentGateConfig => ({
  telegram: { botToken: 'test-token', allowedUsers: [1] },
  watch: { directory: './drafts/inbox', pollIntervalMs: 2000 },
  approval: { bodyPreviewChars: 2000, allowTruncatedApproval: false },
  security: { enforceProductionPermissions: false },
  providers: {
    'gmail-personal': smtpProvider('personal@gmail.com'),
    'gmail-business': smtpProvider('business@gmail.com')
  },
  mailboxProfiles: {
    personal: { provider: 'gmail-personal' },
    business: { provider: 'gmail-business' }
  },
  defaults: { provider: 'gmail-personal', timezone: 'UTC' },
  audit: { enabled: false, logFile: './audit.log' }
});

test('two Gmail profiles resolve to separate provider credentials', () => {
  const profiles = mailboxProfilesFromConfig(configWithProfiles());
  assert.deepEqual([...profiles.keys()], ['business', 'personal']);
  assert.equal(profiles.get('personal')?.providerName, 'gmail-personal');
  assert.equal(profiles.get('personal')?.address, 'personal@gmail.com');
  assert.equal(profiles.get('business')?.credentials.username, 'business@gmail.com');
});

test('multiple Outlook accounts and Gmail can coexist as separate profiles', () => {
  const config = configWithProfiles();
  config.providers['outlook-work'] = outlookProvider('work@outlook.com');
  config.providers['outlook-consulting'] = outlookProvider('consulting@outlook.com');
  config.mailboxProfiles = {
    ...config.mailboxProfiles,
    work: { provider: 'outlook-work' },
    consulting: { provider: 'outlook-consulting' }
  };

  const profiles = mailboxProfilesFromConfig(config);
  assert.equal(profiles.get('work')?.backend, 'outlook');
  assert.equal(profiles.get('consulting')?.address, 'consulting@outlook.com');
  assert.equal(profiles.get('personal')?.backend, 'gmail');
});

test('Outlook mailbox profile requires explicit mailboxAccess scope configuration', () => {
  const config = configWithProfiles();
  config.providers['outlook-work'] = outlookProvider('work@outlook.com', false);
  config.mailboxProfiles = { work: { provider: 'outlook-work' } };
  assert.throws(() => mailboxProfilesFromConfig(config), /not supported/);
});

test('first named profile preserves an existing implicit gmail-smtp mailbox as default', () => {
  const config = configWithProfiles();
  config.providers = {
    'gmail-smtp': smtpProvider('existing@gmail.com'),
    'outlook-work': outlookProvider('work@outlook.com')
  };
  config.mailboxProfiles = { work: { provider: 'outlook-work' } };

  const profiles = mailboxProfilesFromConfig(config);
  assert.deepEqual([...profiles.keys()], ['default', 'work']);
  assert.equal(profiles.get('default')?.address, 'existing@gmail.com');
});

test('explicit Gmail profile suppresses a duplicate implicit default for the same address', () => {
  const config = configWithProfiles();
  config.providers = {
    'gmail-smtp': smtpProvider('existing@gmail.com'),
    'gmail-personal': smtpProvider('existing@gmail.com')
  };
  config.mailboxProfiles = { personal: { provider: 'gmail-personal' } };

  const profiles = mailboxProfilesFromConfig(config);
  assert.deepEqual([...profiles.keys()], ['personal']);
});

test('profile-bound Gmail reference round-trips canonically', () => {
  const encoded = encodeInboxReference({
    profile: 'business',
    backend: 'gmail',
    uidValidity: '123',
    uid: 44
  });
  assert.deepEqual(decodeInboxReference(encoded), {
    v: 2,
    profile: 'business',
    backend: 'gmail',
    folder: 'inbox',
    uidValidity: '123',
    uid: 44
  });
});

test('valid long Outlook references pass Trash and unsubscribe draft validation', () => {
  const ref = encodeOutlookInboxReference({ profile: 'work', messageId: 'A'.repeat(256) });
  assert(ref.length > 256);
  const common = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    status: 'pending' as const,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    source: 'test',
    provider: 'outlook-work'
  };
  assert.doesNotThrow(() => DraftSchema.parse({ ...common, type: 'mailbox-trash', payload: { refs: [ref] } }));
  assert.doesNotThrow(() => DraftSchema.parse({ ...common, type: 'mailbox-unsubscribe', payload: { ref } }));
});

test('legacy Gmail references follow only the gmail-smtp compatibility provider even when renamed', () => {
  const legacyReference = decodeInboxReference(encodeInboxReference({ uidValidity: '123', uid: 44 }));
  const credentials = { username: 'personal@gmail.com', password: 'test-password' };
  const namedBroker = new GmailInboxBroker(credentials, 'personal', 'gmail-personal', 'personal@gmail.com');
  const compatibilityBroker = new GmailInboxBroker(credentials, 'personal', 'gmail-smtp', 'personal@gmail.com');
  const namedInboxGuard = namedBroker as unknown as { assertProfile(reference: unknown): void };
  const compatibilityInboxGuard = compatibilityBroker as unknown as { assertProfile(reference: unknown): void };
  assert.throws(() => namedInboxGuard.assertProfile(legacyReference), /different profile/);
  assert.doesNotThrow(() => compatibilityInboxGuard.assertProfile(legacyReference));

  const namedTrash = new GmailMailboxTrashService(credentials, 'personal', 'gmail-personal', 'personal@gmail.com') as unknown as {
    assertProfile(references: unknown[]): void;
  };
  const compatibilityTrash = new GmailMailboxTrashService(credentials, 'personal', 'gmail-smtp', 'personal@gmail.com') as unknown as {
    assertProfile(references: unknown[]): void;
  };
  assert.throws(() => namedTrash.assertProfile([legacyReference]), /different profile/);
  assert.doesNotThrow(() => compatibilityTrash.assertProfile([legacyReference]));

  const namedUnsubscribe = new GmailUnsubscribeService(credentials, 'personal', 'gmail-personal', 'personal@gmail.com') as unknown as {
    assertProfile(reference: unknown): void;
  };
  const compatibilityUnsubscribe = new GmailUnsubscribeService(credentials, 'personal', 'gmail-smtp', 'personal@gmail.com') as unknown as {
    assertProfile(reference: unknown): void;
  };
  assert.throws(() => namedUnsubscribe.assertProfile(legacyReference), /different profile/);
  assert.doesNotThrow(() => compatibilityUnsubscribe.assertProfile(legacyReference));
});

test('legacy Gmail references route to the unique gmail-smtp compatibility profile', async () => {
  const compatibility: MailboxAdapter = {
    profile: 'personal',
    providerName: 'gmail-smtp',
    backend: 'gmail',
    address: 'personal@gmail.com',
    list: async () => ({ items: [], scannedUidWindow: 0, truncated: false }),
    read: async () => { throw new Error('routed:personal'); },
    markRead: async () => ({ outcome: 'applied', requested: 1, verified: 1 })
  };
  const work: MailboxAdapter = {
    profile: 'work',
    providerName: 'outlook-work',
    backend: 'outlook',
    address: 'work@outlook.com',
    list: async () => ({ items: [], scannedUidWindow: 0, truncated: false }),
    read: async () => { throw new Error('routed:work'); },
    markRead: async () => ({ outcome: 'partial', requested: 1, verified: 0 })
  };
  const broker = new MailboxBrokerServer(
    new Map([['personal', compatibility], ['work', work]]),
    '/run/agent-gate-mailbox/broker.sock',
    1,
    async (profile) => ({ profile }),
    async (profile) => ({ profile })
  ) as unknown as { execute(request: unknown): Promise<unknown> };
  const ref = encodeInboxReference({ uidValidity: '123', uid: 44 });
  const request = (op: string, fields: Record<string, unknown>) => ({
    v: 1,
    id: '550e8400-e29b-41d4-a716-446655440000',
    op,
    ...fields
  });

  await assert.rejects(() => broker.execute(request('read', { ref })), /routed:personal/);
  assert.deepEqual(await broker.execute(request('mark-read', { refs: [ref] })), {
    outcome: 'applied', requested: 1, verified: 1
  });
  assert.deepEqual(await broker.execute(request('propose-trash', { refs: [ref], context: 'test' })), {
    profile: 'personal'
  });
  assert.deepEqual(await broker.execute(request('propose-unsubscribe', { ref, context: 'test' })), {
    profile: 'personal'
  });
});

test('profile routing rejects a canonical reference whose backend disagrees with the configured profile', async () => {
  let proposals = 0;
  const work: MailboxAdapter = {
    profile: 'work',
    providerName: 'outlook-work',
    backend: 'outlook',
    address: 'work@outlook.com',
    list: async () => ({ items: [], scannedUidWindow: 0, truncated: false }),
    read: async () => { throw new Error('adapter must not run'); },
    markRead: async () => { throw new Error('adapter must not run'); }
  };
  const broker = new MailboxBrokerServer(
    new Map([['work', work]]),
    '/run/agent-gate-mailbox/broker.sock',
    1,
    async () => { proposals += 1; return {}; },
    async () => { proposals += 1; return {}; }
  ) as unknown as { execute(request: unknown): Promise<unknown> };
  const forged = encodeInboxReference({
    profile: 'work',
    backend: 'gmail',
    uidValidity: '123',
    uid: 44
  });
  const request = (op: string, fields: Record<string, unknown>) => ({
    v: 1,
    id: '550e8400-e29b-41d4-a716-446655440000',
    op,
    ...fields
  });

  await assert.rejects(() => broker.execute(request('read', { ref: forged })), /different profile/);
  await assert.rejects(() => broker.execute(request('mark-read', { refs: [forged] })), /different profile/);
  await assert.rejects(() => broker.execute(request('propose-trash', { refs: [forged], context: 'test' })), /different profile/);
  await assert.rejects(() => broker.execute(request('propose-unsubscribe', { ref: forged, context: 'test' })), /different profile/);
  assert.equal(proposals, 0);
});

test('request byte cap accepts the schema maximum batch of long Outlook references', () => {
  const refs = Array.from({ length: 20 }, (_, index) => encodeOutlookInboxReference({
    profile: 'work',
    messageId: `${String(index).padStart(2, '0')}${'A'.repeat(2046)}`
  }));
  const request = {
    v: 1 as const,
    id: '550e8400-e29b-41d4-a716-446655440000',
    op: 'propose-trash' as const,
    refs,
    context: 'x'.repeat(1000)
  };

  assert.doesNotThrow(() => MailboxRequestSchema.parse(request));
  assert.ok(Buffer.byteLength(`${JSON.stringify(request)}\n`, 'utf8') <= MAX_REQUEST_BYTES);
});

test('Gmail HTTPS unsubscribe rejects a snapshot from another backend before network access', async () => {
  const service = new GmailUnsubscribeService({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: 'personal@gmail.com', pass: 'secret' }
  }, 'personal', 'gmail-personal', 'personal@gmail.com');

  await assert.rejects(() => service.executeHttps({
    method: 'rfc8058-https-post',
    backend: 'outlook',
    provider: 'gmail-personal',
    profile: 'personal',
    account: 'personal@gmail.com'
  } as never), /profile changed/);
});

test('profiles response exposes the exact outbound provider mapping', async () => {
  const adapter: MailboxAdapter = {
    profile: 'work',
    providerName: 'outlook-work',
    backend: 'outlook',
    address: 'work@outlook.com',
    list: async () => ({ items: [], scannedUidWindow: 0, truncated: false }),
    read: async () => { throw new Error('not used'); },
    markRead: async () => ({ outcome: 'applied', requested: 0, verified: 0 })
  };
  const broker = new MailboxBrokerServer(
    new Map([['work', adapter]]),
    '/run/agent-gate-mailbox/broker.sock',
    1
  ) as unknown as { execute(request: unknown): Promise<unknown> };
  const result = await broker.execute({
    v: 1,
    id: '550e8400-e29b-41d4-a716-446655440000',
    op: 'profiles'
  });
  assert.deepEqual(result, {
    profiles: [{ name: 'work', provider: 'outlook-work', providerType: 'outlook', address: 'work@outlook.com' }]
  });
});

test('mailbox CLI accepts profiles and list profile selection', () => {
  const profiles = parseMailboxClientArgs(['profiles']);
  if (profiles === 'help') throw new Error('unexpected help response');
  assert.equal(profiles.op, 'profiles');

  const list = parseMailboxClientArgs(['list', '--profile', 'business', '--unread', '--limit', '7']);
  if (list === 'help' || list.op !== 'list') throw new Error('unexpected list response');
  assert.deepEqual(
    { op: list.op, profile: list.profile, unread: list.unread, limit: list.limit },
    { op: 'list', profile: 'business', unread: true, limit: 7 }
  );
});

test('mailbox approval previews show the selected profile and account', () => {
  const ref = encodeInboxReference({ profile: 'business', backend: 'gmail', uidValidity: '123', uid: 44 });
  const base = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    status: 'pending',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    source: 'test',
    provider: 'gmail-business',
    metadata: { context: 'profile check', priority: 'normal', tags: [] }
  } as const;
  const trashDraft = DraftSchema.parse({ ...base, type: 'mailbox-trash', payload: { refs: [ref] } });
  const trashPreview = buildMailboxTrashPreview(trashDraft, {
    provider: 'gmail-business',
    profile: 'business',
    account: 'business@gmail.com',
    sourcePath: 'INBOX',
    trashPath: '[Gmail]/Trash',
    uidValidity: '123',
    uids: [44],
    items: [{ uid: 44, from: 'sender@example.com', subject: 'Offer', receivedAt: null, size: 20 }]
  });
  assert.match(trashPreview.text, /Profile: business \(business@gmail\.com\)/);

  const unsubscribeDraft = DraftSchema.parse({ ...base, type: 'mailbox-unsubscribe', payload: { ref } });
  const unsubscribePreview = buildMailboxUnsubscribePreview(unsubscribeDraft, {
    provider: 'gmail-business',
    profile: 'business',
    account: 'business@gmail.com',
    sourcePath: 'INBOX',
    uidValidity: '123',
    uid: 44,
    from: 'sender@example.com',
    subjectLine: 'Offer',
    receivedAt: null,
    method: 'rfc8058-https-post',
    endpointUrl: 'https://example.com/unsubscribe/token',
    endpointHost: 'example.com'
  });
  assert.match(unsubscribePreview.text, /Profile: business \(business@gmail\.com\)/);
});
