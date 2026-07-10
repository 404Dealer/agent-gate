import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentGateConfig } from '../src/config.js';
import { Executor } from '../src/executor.js';
import { buildDeliveryNotification, executeAndNotifyDelivery } from '../src/bot.js';
import type { Provider, ProviderResult } from '../src/providers/index.js';
import { DraftSchema } from '../src/schema.js';

test('executor preserves partial delivery as non-retryable sent state and returns a warning result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-gate-executor-partial-'));
  try {
    for (const directory of ['approved', 'sent', 'failed']) {
      await mkdir(join(root, directory));
    }
    const auditPath = join(root, 'audit.log');
    const draft = DraftSchema.parse({
      id: randomUUID(),
      type: 'email',
      status: 'approved',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: 'test-agent',
      provider: 'smtp',
      payload: {
        from: 'ignored@example.com',
        to: 'accepted@example.com',
        cc: ['rejected@example.com'],
        subject: 'Partial delivery test',
        body: '<p>Test</p>'
      }
    });
    const fileName = `${draft.id}.json`;
    const approvedPath = join(root, 'approved', fileName);
    await writeFile(approvedPath, JSON.stringify(draft), 'utf8');

    const provider: Provider = {
      describeSender: () => 'sender@example.com',
      send: async () => ({
        outcome: 'partial',
        providerMessageId: '<partial@example.com>',
        details: 'Email accepted by SMTP for 1 recipient; 1 rejected',
        acceptedCount: 1,
        rejectedCount: 1,
        rejectedRecipients: ['rejected@example.com']
      })
    };
    const config = {
      telegram: { botToken: 'test', allowedUsers: [1] },
      watch: { directory: join(root, 'inbox'), pollIntervalMs: 1000 },
      approval: { bodyPreviewChars: 2000, allowTruncatedApproval: false },
      security: { enforceProductionPermissions: false },
      providers: { smtp: { type: 'log-only' } },
      defaults: { provider: 'smtp', timezone: 'UTC' },
      audit: { enabled: true, logFile: auditPath }
    } as AgentGateConfig;

    const executor = new Executor(config, root, { smtp: provider });
    const result = await executor.executeApprovedDraft(approvedPath);

    assert.deepEqual(result, {
      outcome: 'partial',
      details: 'Email accepted by SMTP for 1 recipient; 1 rejected',
      acceptedCount: 1,
      rejectedCount: 1,
      rejectedRecipients: ['rejected@example.com']
    });
    const archived = DraftSchema.parse(JSON.parse(await readFile(join(root, 'sent', fileName), 'utf8')));
    assert.equal(archived.status, 'sent');
    await assert.rejects(() => readFile(join(root, 'failed', fileName), 'utf8'));

    const audit = JSON.parse((await readFile(auditPath, 'utf8')).trim()) as Record<string, unknown>;
    assert.equal(audit.action, 'partial');
    assert.deepEqual(audit.rejectedRecipients, ['rejected@example.com']);
    assert.equal(audit.acceptedCount, 1);
    assert.equal(audit.rejectedCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bot notification makes partial delivery explicit and warns against automatic retry', () => {
  const notification = buildDeliveryNotification({
    outcome: 'partial',
    details: 'Email accepted by SMTP for 1 recipient; 1 rejected',
    acceptedCount: 1,
    rejectedCount: 1,
    rejectedRecipients: ['rejected@example.com']
  });

  assert.deepEqual(notification, {
    callbackText: '⚠️ Partial delivery',
    showAlert: true,
    replyText: '⚠️ Partial delivery: 1 recipient accepted; 1 rejected (rejected@example.com). The draft is archived as sent. Do not retry automatically because accepted recipients may receive duplicates.'
  });
});

test('bot notification preserves the ordinary full-success response', () => {
  assert.deepEqual(buildDeliveryNotification({ outcome: 'sent', details: 'ok' }), {
    callbackText: '✅ Sent successfully!',
    showAlert: false
  });
});

test('delivery callback is acknowledged before execution and full success is posted afterward', async () => {
  const events: string[] = [];
  await executeAndNotifyDelivery(
    async () => {
      events.push('execute');
      return { outcome: 'sent', details: 'accepted' };
    },
    {
      acknowledge: async (text) => { events.push(`ack:${text}`); },
      reply: async (text) => { events.push(`reply:${text}`); }
    }
  );

  assert.deepEqual(events, [
    'ack:✅ Approved; sending…',
    'execute',
    'reply:✅ Sent successfully!'
  ]);
});

test('Telegram notification failure after acceptance never becomes a send-failed report', async () => {
  const events: string[] = [];
  await executeAndNotifyDelivery(
    async () => {
      events.push('execute');
      return {
        outcome: 'partial',
        details: 'partial',
        acceptedCount: 1,
        rejectedCount: 1,
        rejectedRecipients: ['rejected@example.com']
      };
    },
    {
      acknowledge: async (text) => { events.push(`ack:${text}`); },
      reply: async (text) => {
        events.push(`reply:${text}`);
        throw new Error('Telegram unavailable');
      }
    }
  );

  assert.equal(events[0], 'ack:✅ Approved; sending…');
  assert.equal(events[1], 'execute');
  assert.match(events[2] ?? '', /Partial delivery/);
  assert.equal(events.some((event) => /send failed/i.test(event)), false);
  assert.equal(events.length, 3);
});

test('post-acceptance persistence failure never reports delivery as failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-gate-executor-persistence-warning-'));
  try {
    for (const directory of ['approved', 'sent', 'failed']) {
      await mkdir(join(root, directory));
    }
    const draft = DraftSchema.parse({
      id: randomUUID(),
      type: 'email',
      status: 'approved',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: 'test-agent',
      provider: 'smtp',
      payload: {
        from: 'ignored@example.com',
        to: 'accepted@example.com',
        subject: 'Persistence warning test',
        body: '<p>Test</p>'
      }
    });
    await writeFile(join(root, 'approved', `${draft.id}.json`), JSON.stringify(draft), 'utf8');
    const config = {
      telegram: { botToken: 'test', allowedUsers: [1] },
      watch: { directory: join(root, 'inbox'), pollIntervalMs: 1000 },
      approval: { bodyPreviewChars: 2000, allowTruncatedApproval: false },
      security: { enforceProductionPermissions: false },
      providers: { smtp: { type: 'log-only' } },
      defaults: { provider: 'smtp', timezone: 'UTC' },
      audit: { enabled: true, logFile: join(root, 'missing-directory', 'audit.log') }
    } as AgentGateConfig;
    const provider: Provider = {
      describeSender: () => 'sender@example.com',
      send: async (): Promise<ProviderResult> => ({ details: 'accepted' })
    };
    const executor = new Executor(config, root, { smtp: provider });

    const result = await executor.executeApprovedDraft(join(root, 'approved', `${draft.id}.json`));
    assert.deepEqual(result, {
      outcome: 'sent',
      details: 'accepted',
      persistenceWarning: true
    });
    assert.equal(
      JSON.parse(await readFile(join(root, 'sent', `${draft.id}.json`), 'utf8')).status,
      'sent'
    );
    await assert.rejects(() => readFile(join(root, 'failed', `${draft.id}.json`), 'utf8'), /ENOENT/);

    const notification = buildDeliveryNotification(result);
    assert.equal(notification.showAlert, true);
    assert.match(notification.callbackText, /record warning/i);
    assert.match(notification.replyText ?? '', /accepted/i);
    assert.match(notification.replyText ?? '', /Do not retry automatically/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
