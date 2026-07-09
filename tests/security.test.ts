import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildApprovalPreview, createApprovalToken, sha256hex } from '../src/bot.js';
import { verifyDraftDirectoryIsolation } from '../src/security.js';
import { DraftSchema } from '../src/schema.js';

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
});

test('production isolation verifier rejects an inbox without dropbox permissions', async () => {
  const root = await mktempDir();
  const inbox = join(root, 'inbox');
  const pending = join(root, 'pending');
  await mkdir(inbox, { recursive: true });
  await mkdir(pending, { recursive: true });
  await chmod(inbox, 0o755);
  await chmod(pending, 0o700);

  const result = await verifyDraftDirectoryIsolation({ rootDir: root, inboxDir: inbox });
  assert.equal(result.ok, false);
  assert(result.errors.some((e) => e.includes('1730')));

  await rm(root, { recursive: true, force: true });
});

test('production isolation verifier accepts a write-only inbox and private state dirs', async () => {
  const root = await mktempDir();
  const inbox = join(root, 'inbox');
  await mkdir(inbox, { recursive: true });
  for (const dir of ['pending', 'approved', 'sent', 'denied', 'failed']) {
    await mkdir(join(root, dir), { recursive: true });
    await chmod(join(root, dir), 0o700);
  }
  await chmod(inbox, 0o1730);

  const mode = (await stat(inbox)).mode & 0o7777;
  assert.equal(mode, 0o1730);
  const result = await verifyDraftDirectoryIsolation({ rootDir: root, inboxDir: inbox });
  assert.equal(result.ok, true, result.errors.join('\n'));

  await rm(root, { recursive: true, force: true });
});

async function mktempDir(): Promise<string> {
  return await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'agent-gate-test-')));
}
