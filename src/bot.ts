import { createHash, randomBytes } from 'node:crypto';
import { Bot, InlineKeyboard } from 'grammy';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { AgentGateConfig } from './config.js';
import type { DraftWatcher } from './watcher.js';
import { DraftSchema, updateStatus, type Draft } from './schema.js';
import { Executor, type ExecutionResult } from './executor.js';
import type { MailboxTrashSnapshot } from './mailbox-broker/gmail-trash.js';
import type { MailboxUnsubscribeSnapshot } from './mailbox-broker/gmail-unsubscribe.js';

export interface ApprovalPreviewOptions {
  configuredSender: string;
  providerName: string;
  bodyPreviewChars: number;
  allowTruncatedApproval: boolean;
}

export interface ApprovalPreview {
  text: string;
  canApprove: boolean;
  fullBodyChars: number;
  shownBodyChars: number;
}

export interface ApprovalTokenRecord {
  callbackToken: string;
  fileName: string;
  hash: string;
  expiresAt: number;
  mailboxTrashSnapshot?: MailboxTrashSnapshot;
  mailboxUnsubscribeSnapshot?: MailboxUnsubscribeSnapshot;
}

export interface DeliveryNotification {
  callbackText: string;
  showAlert: boolean;
  replyText?: string;
}

const countLabel = (count: number): string => count === 1 ? 'recipient' : 'recipients';

type PartialExecutionResult = Extract<ExecutionResult, { outcome: 'partial' }>;

const partialDeliverySummary = (result: PartialExecutionResult): string => {
  const accepted = result.acceptedCount;
  const rejected = result.rejectedCount;
  const rejectedRecipients = result.rejectedRecipients;
  const shownRecipients = rejectedRecipients.slice(0, 10);
  const remaining = Math.max(0, rejectedRecipients.length - shownRecipients.length);
  const rejectedDetail = shownRecipients.length > 0
    ? ` (${shownRecipients.join(', ')}${remaining > 0 ? `, and ${remaining} more` : ''})`
    : '';
  return `${accepted} ${countLabel(accepted)} accepted; ${rejected} rejected${rejectedDetail}`;
};

export function buildDeliveryNotification(result: ExecutionResult): DeliveryNotification {
  if (result.persistenceWarning) {
    const partialDetail = result.outcome === 'partial'
      ? ` SMTP reported ${partialDeliverySummary(result)}.`
      : '';
    return {
      callbackText: '⚠️ Delivery accepted; record warning',
      showAlert: true,
      replyText: `⚠️ Delivery was accepted, but local archive/audit state could not be finalized.${partialDetail} Do not retry automatically because recipients may receive duplicates.`
    };
  }

  if (result.outcome !== 'partial') {
    return { callbackText: '✅ Sent successfully!', showAlert: false };
  }

  return {
    callbackText: '⚠️ Partial delivery',
    showAlert: true,
    replyText: `⚠️ Partial delivery: ${partialDeliverySummary(result)}. The draft is archived as sent. Do not retry automatically because accepted recipients may receive duplicates.`
  };
}

export interface DeliveryNotificationChannel {
  acknowledge(text: string): Promise<unknown>;
  reply(text: string): Promise<unknown>;
}

export async function executeAndNotifyDelivery(
  execute: () => Promise<ExecutionResult>,
  channel: DeliveryNotificationChannel
): Promise<void> {
  await channel.acknowledge('✅ Approved; sending…').catch(() => {});

  let result: ExecutionResult;
  try {
    result = await execute();
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const safeError = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
    await channel.reply(`⚠️ Approved but send failed: ${safeError}`).catch(() => {});
    return;
  }

  const notification = buildDeliveryNotification(result);
  await channel.reply(notification.replyText ?? notification.callbackText).catch(() => {});
}

export async function executeAndNotifyMailboxTrash(
  execute: () => Promise<ExecutionResult>,
  channel: DeliveryNotificationChannel
): Promise<void> {
  await channel.acknowledge('✅ Approved; moving to Trash…').catch(() => {});
  try {
    const result = await execute();
    if (result.outcome !== 'moved' && result.outcome !== 'move-partial') {
      throw new Error('Unexpected mailbox execution result');
    }
    if (result.persistenceWarning) {
      await channel.reply(`⚠️ Gmail moved ${result.verifiedMovedCount}/${result.requestedCount} message(s), but local archive/audit finalization failed. Do not retry automatically.`).catch(() => {});
    } else if (result.outcome === 'moved') {
      await channel.reply(`🗑️ Moved ${result.verifiedMovedCount} message(s) to Gmail Trash.`).catch(() => {});
    } else {
      await channel.reply(`⚠️ Gmail move was only partially verified (${result.verifiedMovedCount}/${result.requestedCount}). Do not retry automatically.`).catch(() => {});
    }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const safeError = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
    await channel.reply(`⚠️ Approved but move to Trash failed: ${safeError}`).catch(() => {});
  }
}

export async function executeAndNotifyMailboxUnsubscribe(
  execute: () => Promise<ExecutionResult>,
  channel: DeliveryNotificationChannel
): Promise<void> {
  await channel.acknowledge('✅ Approved; requesting unsubscribe…').catch(() => {});
  try {
    const result = await execute();
    if (
      result.outcome !== 'unsubscribe-accepted' &&
      result.outcome !== 'unsubscribe-rejected' &&
      result.outcome !== 'unsubscribe-ambiguous'
    ) {
      throw new Error('Unexpected unsubscribe execution result');
    }
    const method = result.method === 'https' ? 'HTTPS one-click' : 'unsubscribe email';
    if (result.persistenceWarning) {
      await channel.reply(`⚠️ ${method} was attempted, but local archive/audit finalization failed. Do not retry automatically.`).catch(() => {});
    } else if (result.outcome === 'unsubscribe-accepted') {
      await channel.reply(`✅ ${method} request accepted. Future delivery may take time to stop.`).catch(() => {});
    } else if (result.outcome === 'unsubscribe-rejected') {
      await channel.reply(`⚠️ ${method} request was rejected: ${result.details}`).catch(() => {});
    } else {
      await channel.reply(`⚠️ ${method} outcome could not be confirmed. It may have succeeded; do not retry automatically.`).catch(() => {});
    }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const safeError = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
    await channel.reply(`⚠️ Approved but unsubscribe failed: ${safeError}`).catch(() => {});
  }
}

const APPROVAL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const preview = (value: string, limit: number): string => (value.length > limit ? `${value.slice(0, limit)}...` : value);
export const sha256hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export function createApprovalToken(fileName: string, rawDraft: string, ttlMs = APPROVAL_TOKEN_TTL_MS): ApprovalTokenRecord {
  return {
    callbackToken: randomBytes(16).toString('hex'),
    fileName,
    hash: sha256hex(rawDraft),
    expiresAt: Date.now() + ttlMs
  };
}

export function buildApprovalPreview(draft: Draft, options: ApprovalPreviewOptions): ApprovalPreview {
  const payload = draft.payload as {
    from?: string;
    to?: string | string[];
    subject?: string;
    body?: string;
  };

  const body = payload.body ?? '[no body]';
  const shownBody = preview(body, options.bodyPreviewChars);
  const isTruncated = body.length > options.bodyPreviewChars;
  const canApprove = !isTruncated || options.allowTruncatedApproval;
  const to = Array.isArray(payload.to) ? payload.to.join(', ') : (payload.to ?? '[none]');
  const fromLine = draft.type === 'email'
    ? `From: ${options.configuredSender}`
    : `Provider: ${options.providerName}`;
  const ignoredFromLine = draft.type === 'email' && payload.from
    ? `Draft requested From (ignored): ${payload.from}`
    : null;

  const warningLines = isTruncated
    ? [
        '⚠️ Body preview is truncated.',
        canApprove
          ? 'Approval is allowed by config, but review the full draft file before approving long content.'
          : 'APPROVAL DISABLED: configure approval.allowTruncatedApproval=true only if your deployment provides a full-draft review path.'
      ]
    : [];

  const lines = [
    draft.type === 'email' ? '📧 New Email Draft' : '🪝 New Webhook Draft',
    '',
    fromLine,
    ignoredFromLine,
    `To: ${to}`,
    `Subject: ${payload.subject ?? '[n/a]'}`,
    '',
    '─────────────',
    shownBody,
    '─────────────',
    ...warningLines,
    '',
    `Provider: ${options.providerName}`,
    `Source: ${draft.source}`,
    `Context: ${draft.metadata.context || '[none]'}`,
    `Priority: ${draft.metadata.priority || 'normal'}`
  ].filter((line): line is string => line !== null);

  return {
    text: lines.join('\n'),
    canApprove,
    fullBodyChars: body.length,
    shownBodyChars: Math.min(body.length, options.bodyPreviewChars)
  };
}

export function buildMailboxTrashPreview(draft: Extract<Draft, { type: 'mailbox-trash' }>, snapshot: MailboxTrashSnapshot): ApprovalPreview {
  const perItem = Math.max(110, Math.floor(3000 / snapshot.items.length));
  const fromLimit = Math.max(35, Math.floor(perItem * 0.4));
  const subjectLimit = Math.max(50, perItem - fromLimit - 28);
  const itemLines = snapshot.items.map((item, index) => {
    const date = item.receivedAt ? item.receivedAt.slice(0, 10) : 'unknown date';
    return `${index + 1}. UID ${item.uid} · ${preview(item.from, fromLimit)} — ${preview(item.subject, subjectLimit)} — ${date}`;
  });
  const text = [
    '🗑️ Mailbox Trash Request',
    '',
    `Account: ${preview(snapshot.account, 320)}`,
    `Source: ${snapshot.sourcePath} · UIDVALIDITY ${snapshot.uidValidity}`,
    `Destination: ${preview(snapshot.trashPath.replace(/[\r\n\t]+/g, ' '), 300)}`,
    `Action: Move ${snapshot.items.length} exact message(s) to Gmail Trash`,
    'Permanent deletion/EXPUNGE: unavailable',
    '',
    ...itemLines,
    '',
    `Source: ${draft.source}`,
    `Context: ${preview(draft.metadata.context || '[none]', 500)}`,
    '',
    'Approve only if every listed message should be moved to Trash.'
  ].join('\n');
  return {
    text,
    canApprove: text.length <= 4096,
    fullBodyChars: text.length,
    shownBodyChars: Math.min(text.length, 4096)
  };
}

export function buildMailboxUnsubscribePreview(
  draft: Extract<Draft, { type: 'mailbox-unsubscribe' }>,
  snapshot: MailboxUnsubscribeSnapshot
): ApprovalPreview {
  const date = snapshot.receivedAt ? snapshot.receivedAt.slice(0, 10) : 'unknown date';
  const common = [
    '🚫 Unsubscribe Request',
    '',
    `Account: ${preview(snapshot.account, 320)}`,
    `From: ${preview(snapshot.from, 500)}`,
    `Message subject: ${preview(snapshot.subjectLine, 500)}`,
    `Message: INBOX UID ${snapshot.uid} · UIDVALIDITY ${snapshot.uidValidity} · ${date}`
  ];
  let text: string;
  let canApprove = true;
  if (snapshot.method === 'rfc8058-https-post') {
    text = [
      ...common,
      'Method: RFC 8058 HTTPS one-click POST',
      `Destination host: ${preview(snapshot.endpointHost, 300)}`,
      'Personalized endpoint: hidden inside the approval token',
      '',
      'No browser, cookies, redirect, or message-body link will be used.',
      'The existing message will not be deleted, moved, archived, or marked read.',
      '',
      `Source: ${draft.source}`,
      `Context: ${preview(draft.metadata.context || '[none]', 500)}`
    ].join('\n');
  } else {
    const bodyLimit = 1800;
    const shownBody = preview(snapshot.body, bodyLimit);
    const truncated = snapshot.body.length > bodyLimit;
    text = [
      ...common,
      'Method: RFC 2369 unsubscribe email',
      '',
      `To: ${snapshot.recipient}`,
      `Email subject: ${snapshot.subject}`,
      'Email body:',
      '─────────────',
      shownBody,
      '─────────────',
      'CC/BCC/reply-to/attachments: none',
      ...(truncated ? ['⚠️ Full mailto body does not fit; approval is disabled.'] : []),
      '',
      'The existing message will not be deleted, moved, archived, or marked read.',
      '',
      `Source: ${draft.source}`,
      `Context: ${preview(draft.metadata.context || '[none]', 500)}`
    ].join('\n');
    canApprove = !truncated;
  }
  return {
    text,
    canApprove: canApprove && text.length <= 4096,
    fullBodyChars: text.length,
    shownBodyChars: Math.min(text.length, 4096)
  };
}

export class AgentGateBot {
  private readonly bot: Bot;
  private readonly approvalIndex = new Map<string, ApprovalTokenRecord>();
  private approvalPruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: AgentGateConfig,
    private readonly watcher: DraftWatcher,
    private readonly executor: Executor,
    private readonly draftsRoot: string
  ) {
    this.bot = new Bot(config.telegram.botToken);
  }

  async start(): Promise<void> {
    this.startApprovalTokenPruner();

    this.bot.catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[agent-gate] bot error:', err.message ?? err);
    });

    this.bot.command('start', async (ctx) => {
      const fromId = ctx.from?.id;
      if (!fromId || !this.config.telegram.allowedUsers.includes(fromId)) {
        await ctx.reply('🔒 This bot is private. You are not authorized.');
        // eslint-disable-next-line no-console
        console.log(`[agent-gate] unauthorized /start from user ${fromId} (@${ctx.from?.username ?? 'unknown'})`);
        return;
      }
      await ctx.reply('agent-gate is active. Draft approvals will appear here. Only authorized users can approve or deny.');
    });

    this.bot.use(async (ctx, next) => {
      const fromId = ctx.from?.id;
      if (!fromId || !this.config.telegram.allowedUsers.includes(fromId)) {
        return;
      }
      await next();
    });

    this.bot.callbackQuery(/^(approve|deny):([a-f0-9]{32})$/, async (ctx) => {
      const fromId = ctx.from?.id;
      if (!fromId || !this.config.telegram.allowedUsers.includes(fromId)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized', show_alert: true });
        return;
      }

      const action = ctx.match[1];
      const callbackToken = ctx.match[2];
      this.pruneExpiredApprovalTokens();
      const record = this.approvalIndex.get(callbackToken);
      if (!record || Date.now() > record.expiresAt) {
        if (record) this.approvalIndex.delete(callbackToken);
        await ctx.answerCallbackQuery({ text: '⚠️ Draft expired, restart detected, or already processed', show_alert: true });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
        return;
      }

      // Claim this approval token synchronously before any await. This makes
      // concurrent approve/deny callbacks single-use in this process.
      this.approvalIndex.delete(callbackToken);

      const approvedPath = resolve(this.draftsRoot, 'approved', record.fileName);
      const deniedPath = resolve(this.draftsRoot, 'denied', record.fileName);
      const pendingPath = resolve(this.draftsRoot, 'pending', record.fileName);

      let raw: string;
      try {
        raw = await readFile(pendingPath, 'utf8');
      } catch {
        await ctx.answerCallbackQuery({ text: '⚠️ Draft expired or already processed', show_alert: true });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
        this.approvalIndex.delete(callbackToken);
        return;
      }

      if (action === 'approve') {
        const actualHash = sha256hex(raw);
        if (actualHash !== record.hash) {
          await ctx.answerCallbackQuery({ text: '⚠️ Draft changed since preview. Approval rejected.', show_alert: true });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          this.approvalIndex.delete(callbackToken);
          return;
        }
      }

      const draft = DraftSchema.parse(JSON.parse(raw));
      const originalText = ctx.callbackQuery.message?.text ?? '';
      const timestamp = new Date().toLocaleString('en-US', { timeZone: this.config.defaults.timezone, hour: 'numeric', minute: '2-digit', hour12: true });

      if (action === 'approve') {
        const approvedDraft = updateStatus(draft, 'approved', {
          approval: {
            ...draft.approval,
            approvedBy: String(fromId),
            approvedAt: new Date().toISOString(),
            telegramMessageId: ctx.callbackQuery.message?.message_id ?? draft.approval.telegramMessageId
          }
        });

        try {
          await writeFile(pendingPath, JSON.stringify(approvedDraft, null, 2), 'utf8');
          await rename(pendingPath, approvedPath);
        } catch {
          await ctx.answerCallbackQuery({ text: '⚠️ Draft already processed by another approver', show_alert: true });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          return;
        }
        await ctx.editMessageText(`${originalText}\n\n✅ APPROVED at ${timestamp}`).catch(() => {});

        const channel = {
          acknowledge: (text: string) => ctx.answerCallbackQuery({ text }),
          reply: (text: string) => ctx.reply(text)
        };
        if (draft.type === 'mailbox-trash') {
          await executeAndNotifyMailboxTrash(
            () => this.executor.executeApprovedDraft(approvedPath, record.mailboxTrashSnapshot),
            channel
          );
        } else if (draft.type === 'mailbox-unsubscribe') {
          await executeAndNotifyMailboxUnsubscribe(
            () => this.executor.executeApprovedDraft(approvedPath, undefined, record.mailboxUnsubscribeSnapshot),
            channel
          );
        } else {
          await executeAndNotifyDelivery(
            () => this.executor.executeApprovedDraft(approvedPath),
            channel
          );
        }
        return;
      }

      if (action === 'deny') {
        const deniedDraft = updateStatus(draft, 'denied', {
          approval: {
            ...draft.approval,
            deniedBy: String(fromId),
            deniedAt: new Date().toISOString(),
            telegramMessageId: ctx.callbackQuery.message?.message_id ?? draft.approval.telegramMessageId
          }
        });

        await writeFile(pendingPath, JSON.stringify(deniedDraft, null, 2), 'utf8');
        await rename(pendingPath, deniedPath);
        this.approvalIndex.delete(callbackToken);
        await ctx.editMessageText(`${originalText}\n\n❌ DENIED at ${timestamp}`).catch(() => {});
        await ctx.answerCallbackQuery({ text: '❌ Draft denied' });
        return;
      }

      await ctx.answerCallbackQuery();
    });

    this.watcher.on('draft', async ({ draft, filePath }) => {
      try {
        await this.sendDraftForApproval(draft, basename(filePath));
      } catch (err) {
        const safeError = err instanceof Error ? err.message : 'Approval preview failed';
        await this.watcher.failPending(filePath, safeError).catch(() => {});
        // eslint-disable-next-line no-console
        console.error(`[agent-gate] failed to send draft preview for ${basename(filePath)}:`, safeError);
      }
    });
  }

  async poll(): Promise<void> {
    await this.bot.start();
  }

  async stop(): Promise<void> {
    if (this.approvalPruneTimer) {
      clearInterval(this.approvalPruneTimer);
      this.approvalPruneTimer = null;
    }
    await this.bot.stop();
  }

  private startApprovalTokenPruner(): void {
    if (this.approvalPruneTimer) return;
    this.approvalPruneTimer = setInterval(() => this.pruneExpiredApprovalTokens(), 60 * 60 * 1000);
    this.approvalPruneTimer.unref?.();
  }

  private pruneExpiredApprovalTokens(now = Date.now()): void {
    for (const [callbackToken, record] of this.approvalIndex.entries()) {
      if (record.expiresAt <= now) {
        this.approvalIndex.delete(callbackToken);
      }
    }
  }

  private async sendDraftForApproval(_draft: Draft, fileName: string): Promise<void> {
    const draftPath = resolve(this.draftsRoot, 'pending', fileName);
    const draftRaw = await readFile(draftPath, 'utf8');
    const boundDraft = DraftSchema.parse(JSON.parse(draftRaw));
    let token = createApprovalToken(fileName, draftRaw);
    const providerName = boundDraft.provider || this.config.defaults.provider;
    let previewResult: ApprovalPreview;
    if (boundDraft.type === 'mailbox-trash') {
      const mailboxTrashSnapshot = await this.executor.prepareMailboxTrash(boundDraft);
      token = { ...token, mailboxTrashSnapshot };
      previewResult = buildMailboxTrashPreview(boundDraft, mailboxTrashSnapshot);
    } else if (boundDraft.type === 'mailbox-unsubscribe') {
      const mailboxUnsubscribeSnapshot = await this.executor.prepareMailboxUnsubscribe(boundDraft);
      token = { ...token, mailboxUnsubscribeSnapshot };
      previewResult = buildMailboxUnsubscribePreview(boundDraft, mailboxUnsubscribeSnapshot);
    } else {
      previewResult = buildApprovalPreview(boundDraft, {
        configuredSender: this.executor.describeProviderSender(providerName),
        providerName,
        bodyPreviewChars: this.config.approval.bodyPreviewChars,
        allowTruncatedApproval: this.config.approval.allowTruncatedApproval
      });
    }
    this.approvalIndex.set(token.callbackToken, token);

    const keyboard = new InlineKeyboard();
    if (previewResult.canApprove) {
      keyboard.text('✅ Approve', `approve:${token.callbackToken}`);
    }
    keyboard.text('❌ Deny', `deny:${token.callbackToken}`);

    const sendResults = await Promise.allSettled(
      this.config.telegram.allowedUsers.map((userId) =>
        this.bot.api.sendMessage(userId, previewResult.text, { reply_markup: keyboard })
      )
    );

    sendResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        // eslint-disable-next-line no-console
        console.error(`[agent-gate] failed to send approval preview to ${this.config.telegram.allowedUsers[index]}:`, result.reason);
      }
    });
  }
}
