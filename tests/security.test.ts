import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildApprovalPreview, createApprovalToken, sha256hex } from '../src/bot.js';
import { verifyDraftDirectoryIsolation } from '../src/security.js';
import { DraftSchema } from '../src/schema.js';
import { DraftWatcher, type DraftEvent } from '../src/watcher.js';

const emailDraft = (body = 'hello') => DraftSchema.parse({
  id: randomUUID(),
  type: 'email',
  status: 'pending',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  source: 'test-agent',
  provider: 'log',
  payload: {
    from: 'spoof@example.com',
    to: 'recipient@example.com',
    subject: 'Subject',
    body
  },
  metadata: { context: 'unit test', priority: 'normal', tags: [] }
});

test('approval preview shows configured sender and labels draft from as ignored', () => {
  const preview = buildApprovalPreview(emailDraft(), {
    configuredSender: 'configured@example.com',
    providerName: 'zoho',
    bodyPreviewChars: 1000,
    allowTruncatedApproval: false
  });

  assert.match(preview.text, /From: configured@example\.com/);
  assert.match(preview.text, /Draft requested From \(ignored\): spoof@example\.com/);
  assert.doesNotMatch(preview.text, /^From: spoof@example\.com/m);
  assert.equal(preview.canApprove, true);
});

test('long bodies disable approval by default so hidden content cannot be approved', () => {
  const preview = buildApprovalPreview(emailDraft('x'.repeat(2000)), {
    configuredSender: 'configured@example.com',
    providerName: 'zoho',
    bodyPreviewChars: 100,
    allowTruncatedApproval: false
  });

  assert.equal(preview.canApprove, false);
  assert.match(preview.text, /APPROVAL DISABLED/);
  assert.match(preview.text, /Body preview is truncated/);
});

test('approval token stores the full sha256 hash, not a short digest', () => {
  const raw = JSON.stringify(emailDraft());
  const token = createApprovalToken('draft.json', raw);

  assert.equal(token.hash, sha256hex(raw));
  assert.equal(token.hash.length, 64);
  assert.match(token.callbackToken, /^[a-f0-9]{32}$/);
  assert(token.expiresAt > Date.now());
});

test('production isolation verifier rejects an inbox without dropbox permissions', async () => {
  const root = await mktempDir();
  try {
    const inbox = join(root, 'inbox');
    const pending = join(root, 'pending');
    await mkdir(inbox, { recursive: true });
    await mkdir(pending, { recursive: true });
    await chmod(inbox, 0o755);
    await chmod(pending, 0o700);

    const result = await verifyDraftDirectoryIsolation({ rootDir: root, inboxDir: inbox });
    assert.equal(result.ok, false);
    assert(result.errors.some((e: string) => e.includes('1730')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production isolation verifier rejects group-writable draft root', async () => {
  const root = await mktempDir();
  try {
    const inbox = join(root, 'inbox');
    await mkdir(inbox, { recursive: true });
    for (const dir of ['pending', 'approved', 'sent', 'denied', 'failed']) {
      await mkdir(join(root, dir), { recursive: true });
      await chmod(join(root, dir), 0o700);
    }
    await chmod(root, 0o770);
    await chmod(inbox, 0o1730);

    const result = await verifyDraftDirectoryIsolation({ rootDir: root, inboxDir: inbox });
    assert.equal(result.ok, false);
    assert(result.errors.some((e: string) => e.includes('group- or world-writable')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production isolation verifier accepts a write-only inbox and private state dirs', async () => {
  const root = await mktempDir();
  try {
    const inbox = join(root, 'inbox');
    await mkdir(inbox, { recursive: true });
    for (const dir of ['pending', 'approved', 'sent', 'denied', 'failed']) {
      await mkdir(join(root, dir), { recursive: true });
      await chmod(join(root, dir), 0o700);
    }
    await chmod(inbox, 0o1730);

    const mode = (await stat(inbox)).mode & 0o7777;
    assert.equal(mode, 0o1730);
    const result = await verifyDraftDirectoryIsolation({
      rootDir: root,
      inboxDir: inbox,
      expectedRootUid: process.getuid?.() ?? 0
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production isolation verifier rejects state not owned by the service identity', async () => {
  const root = await mktempDir();
  try {
    const inbox = join(root, 'inbox');
    await mkdir(inbox, { recursive: true });
    for (const dir of ['pending', 'approved', 'sent', 'denied', 'failed']) {
      await mkdir(join(root, dir), { recursive: true });
      await chmod(join(root, dir), 0o700);
    }
    await chmod(root, 0o750);
    await chmod(inbox, 0o1730);

    const currentUid = process.getuid?.() ?? 0;
    const result = await verifyDraftDirectoryIsolation({
      rootDir: root,
      inboxDir: inbox,
      expectedServiceUid: currentUid + 1,
      expectedRootUid: currentUid
    });
    assert.equal(result.ok, false);
    assert(result.errors.some((error) => error.includes('service UID')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('watcher detaches an agent-owned hard-linked inode before exposing pending state', async () => {
  const root = await mktempDir();
  const watcher = new DraftWatcher({ rootDir: root, inboxDir: join(root, 'inbox'), pollIntervalMs: 20 });
  try {
    const inbox = join(root, 'inbox');
    await mkdir(inbox, { recursive: true });
    await watcher.start();

    const sourcePath = join(root, 'agent-retained-link.json');
    const inboxPath = join(inbox, 'draft.json');
    const original = emailDraft('approved content');
    const replacement = emailDraft('agent changed retained hard link');
    await writeFile(sourcePath, JSON.stringify(original), { encoding: 'utf8', mode: 0o640 });

    const draftEvent = once(watcher, 'draft') as Promise<[DraftEvent]>;
    await link(sourcePath, inboxPath);
    const [event] = await draftEvent;
    await writeFile(sourcePath, JSON.stringify(replacement), 'utf8');

    const pendingPath = join(root, 'pending', 'draft.json');
    const pendingRaw = await readFile(pendingPath, 'utf8');
    const pendingStat = await stat(pendingPath);
    const retainedStat = await stat(sourcePath);
    const pendingDraft = DraftSchema.parse(JSON.parse(pendingRaw));
    assert.equal(event.draft.type, 'email');
    assert.equal(pendingDraft.type, 'email');
    if (event.draft.type !== 'email' || pendingDraft.type !== 'email') {
      throw new Error('Expected email drafts');
    }
    assert.equal(
      'body' in event.draft.payload ? event.draft.payload.body : undefined,
      'approved content'
    );
    assert.equal(
      'body' in pendingDraft.payload ? pendingDraft.payload.body : undefined,
      'approved content'
    );
    assert.notEqual(pendingStat.ino, retainedStat.ino);
    assert.equal(pendingStat.mode & 0o777, 0o600);
  } finally {
    await watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

async function mktempDir(): Promise<string> {
  return await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'nightdrop-test-')));
}
