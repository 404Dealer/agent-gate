import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  NativeMoveOnlyImapFlow,
  classifyMailboxMoveResult,
  type MailboxTrashSnapshot
} from '../src/mailbox-broker/gmail-trash.js';
import {
  decodeInboxReference,
  decodeUniqueInboxReferences,
  encodeInboxReference
} from '../src/mailbox-broker/reference.js';
import { MailboxRequestSchema } from '../src/mailbox-broker/protocol.js';
import { DraftWatcher } from '../src/watcher.js';

const snapshot: MailboxTrashSnapshot = {
  provider: 'gmail-smtp',
  account: 'owner@example.com',
  sourcePath: 'INBOX',
  trashPath: '[Gmail]/Trash',
  uidValidity: '123',
  uids: [10, 11],
  items: [
    { uid: 10, from: 'a@example.com', subject: 'A', receivedAt: null, size: 10 },
    { uid: 11, from: 'b@example.com', subject: 'B', receivedAt: null, size: 20 }
  ]
};

test('native-only IMAP client blocks COPY and delete/EXPUNGE fallback methods', async () => {
  const client = new NativeMoveOnlyImapFlow({
    host: 'localhost',
    port: 993,
    secure: true,
    auth: { user: 'unused', pass: 'unused' },
    logger: false
  });
  await assert.rejects(() => client.messageCopy([10], 'Trash', { uid: true }), /fallback was blocked/);
  await assert.rejects(() => client.messageDelete([10], { uid: true }), /delete\/expunge path was blocked/);
});

test('MOVE classification requires authoritative UIDPLUS mapping for every requested UID', () => {
  assert.equal(classifyMailboxMoveResult(snapshot, false).outcome, 'move-partial');
  assert.equal(classifyMailboxMoveResult(snapshot, {
    path: 'INBOX', destination: '[Gmail]/Trash'
  }).outcome, 'move-partial');
  assert.deepEqual(classifyMailboxMoveResult(snapshot, {
    path: 'INBOX', destination: '[Gmail]/Trash', uidMap: new Map([[10, 110]])
  }), {
    outcome: 'move-partial',
    requestedCount: 2,
    verifiedMovedCount: 1,
    details: 'Gmail MOVE returned a partial UID mapping; do not retry automatically'
  });
  assert.equal(classifyMailboxMoveResult(snapshot, {
    path: 'INBOX', destination: '[Gmail]/Trash', uidMap: new Map([[10, 110], [11, 111]])
  }).outcome, 'moved');
});

test('references must be canonical and semantically unique', () => {
  const canonical = encodeInboxReference({ uidValidity: '123', uid: 10 });
  assert.equal(decodeInboxReference(canonical).uid, 10);
  const nonCanonical = Buffer.from(JSON.stringify({ uid: 10, uidValidity: '123', folder: 'inbox', v: 1 })).toString('base64url');
  assert.throws(() => decodeInboxReference(nonCanonical), /Invalid message reference/);
  assert.throws(() => decodeUniqueInboxReferences([canonical, canonical]), /Duplicate/);
  assert.equal(MailboxRequestSchema.safeParse({
    v: 1,
    id: randomUUID(),
    op: 'propose-trash',
    refs: [canonical, canonical],
    context: 'duplicate check'
  }).success, false);
});

test('pending proposals are replayed after restart before the inbox watcher is exposed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-gate-pending-replay-'));
  try {
    const inboxDir = join(root, 'inbox');
    const pendingDir = join(root, 'pending');
    await mkdir(inboxDir);
    await mkdir(pendingDir);
    const ref = encodeInboxReference({ uidValidity: '123', uid: 10 });
    const now = new Date().toISOString();
    const draft = {
      id: randomUUID(),
      type: 'mailbox-trash',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      source: 'test',
      provider: 'gmail-smtp',
      payload: { refs: [ref] },
      metadata: { context: 'restart replay', priority: 'normal', tags: [] }
    };
    const filePath = join(pendingDir, `${draft.id}.json`);
    await writeFile(filePath, JSON.stringify(draft));
    const watcher = new DraftWatcher({ rootDir: root, inboxDir, pollIntervalMs: 20 });
    const replayed: string[] = [];
    watcher.on('draft', ({ draft: found }) => replayed.push(found.id));
    await watcher.replayPending();
    assert.deepEqual(replayed, [draft.id]);
    await watcher.start();
    await watcher.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
