import { createHash, randomBytes } from 'node:crypto';
import { Bot, InlineKeyboard } from 'grammy';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { AgentGateConfig } from './config.js';
import type { DraftWatcher } from './watcher.js';
import { DraftSchema, updateStatus, type Draft } from './schema.js';
import { Executor, type ExecutionResult } from './executor.js';

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
}

export interface DeliveryNotification {
  callbackText: string;
  showAlert: boolean;
  replyText?: string;
}

const countLabel = (count: number): string => count === 1 ? 'recipient' : 'recipients';

const partialDeliverySummary = (result: ExecutionResult): string => {
  const accepted = result.acceptedCount ?? 0;
  const rejected = result.rejectedCount ?? 0;
  const rejectedRecipients = result.rejectedRecipients ?? [];
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

        await executeAndNotifyDelivery(
          () => this.executor.executeApprovedDraft(approvedPath),
          {
            acknowledge: (text) => ctx.answerCallbackQuery({ text }),
            reply: (text) => ctx.reply(text)
          }
        );
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
        // eslint-disable-next-line no-console
        console.error(`[agent-gate] failed to send draft preview for ${basename(filePath)}:`, err instanceof Error ? err.message : err);
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

  private async sendDraftForApproval(draft: Draft, fileName: string): Promise<void> {
    const draftPath = resolve(this.draftsRoot, 'pending', fileName);
    const draftRaw = await readFile(draftPath, 'utf8');
    const token = createApprovalToken(fileName, draftRaw);
    this.approvalIndex.set(token.callbackToken, token);

    const providerName = draft.provider || this.config.defaults.provider;
    const previewResult = buildApprovalPreview(draft, {
      configuredSender: this.executor.describeProviderSender(providerName),
      providerName,
      bodyPreviewChars: this.config.approval.bodyPreviewChars,
      allowTruncatedApproval: this.config.approval.allowTruncatedApproval
    });

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
