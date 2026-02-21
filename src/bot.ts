import { createHash } from 'node:crypto';
import { Bot, InlineKeyboard } from 'grammy';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { AgentGateConfig } from './config.js';
import type { DraftWatcher } from './watcher.js';
import { DraftSchema, updateStatus, type Draft } from './schema.js';
import { Executor } from './executor.js';

const preview = (value: string, limit = 500): string => (value.length > limit ? `${value.slice(0, limit)}...` : value);
const sha256short = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

export class AgentGateBot {
  private readonly bot: Bot;
  private readonly callbackFileIndex = new Map<string, string>();

  constructor(
    private readonly config: AgentGateConfig,
    private readonly watcher: DraftWatcher,
    private readonly executor: Executor,
    private readonly draftsRoot: string
  ) {
    this.bot = new Bot(config.telegram.botToken);
  }

  async start(): Promise<void> {
    // Global error handler — don't crash on recoverable errors
    this.bot.catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[agent-gate] bot error:', err.message ?? err);
    });

    // Handle /start — greet authorized users, reject everyone else
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

    // Block ALL other messages from unauthorized users
    this.bot.use(async (ctx, next) => {
      const fromId = ctx.from?.id;
      if (!fromId || !this.config.telegram.allowedUsers.includes(fromId)) {
        // Silent drop — don't even acknowledge
        return;
      }
      await next();
    });

    this.bot.callbackQuery(/^(approve|deny):([a-f0-9]{16})(?::([a-f0-9]{16}))?$/, async (ctx) => {
      const fromId = ctx.from?.id;
      if (!fromId || !this.config.telegram.allowedUsers.includes(fromId)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized', show_alert: true });
        return;
      }

      const action = ctx.match[1];
      const callbackToken = ctx.match[2];
      const expectedHash = ctx.match[3];
      const fileName = await this.resolvePendingFileName(callbackToken);
      if (!fileName) {
        await ctx.answerCallbackQuery({ text: '⚠️ Draft expired or already processed', show_alert: true });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
        return;
      }
      const approvedPath = resolve(this.draftsRoot, 'approved', fileName);
      const deniedPath = resolve(this.draftsRoot, 'denied', fileName);
      const pendingPath = resolve(this.draftsRoot, 'pending', fileName);

      let raw: string;
      try {
        raw = await readFile(pendingPath, 'utf8');
      } catch {
        await ctx.answerCallbackQuery({ text: '⚠️ Draft expired or already processed', show_alert: true });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
        return;
      }

      if (action === 'approve') {
        if (!expectedHash) {
          await ctx.answerCallbackQuery({ text: '⚠️ Missing draft hash. Re-open draft.', show_alert: true });
          return;
        }

        const actualHash = sha256short(raw);
        if (actualHash !== expectedHash) {
          await ctx.answerCallbackQuery({ text: '⚠️ Draft changed since preview. Approval rejected.', show_alert: true });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
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

        await writeFile(pendingPath, JSON.stringify(approvedDraft, null, 2), 'utf8');
        await rename(pendingPath, approvedPath);

        // Edit original message to show approved status
        const statusLine = `\n\n✅ APPROVED at ${timestamp}`;
        await ctx.editMessageText(originalText + statusLine).catch(() => {});

        // Execute and report result
        try {
          await this.executor.executeApprovedDraft(approvedPath);
          await ctx.answerCallbackQuery({ text: '✅ Sent successfully!' });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await ctx.reply(`⚠️ Approved but send failed: ${errMsg}`);
          await ctx.answerCallbackQuery({ text: '⚠️ Send failed', show_alert: true });
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

        // Edit original message to show denied status
        const statusLine = `\n\n❌ DENIED at ${timestamp}`;
        await ctx.editMessageText(originalText + statusLine).catch(() => {});
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

  /** Long-running polling — call without await or handle the promise separately */
  async poll(): Promise<void> {
    await this.bot.start();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  private async sendDraftForApproval(draft: Draft, fileName: string): Promise<void> {
    const payload = draft.payload as {
      from?: string;
      to?: string | string[];
      subject?: string;
      body?: string;
    };

    const draftPath = resolve(this.draftsRoot, 'pending', fileName);
    const draftRaw = await readFile(draftPath, 'utf8');
    const draftHash = sha256short(draftRaw);

    const bodyPreview = payload.body ? preview(payload.body) : '[no body]';
    const to = Array.isArray(payload.to) ? payload.to.join(', ') : (payload.to ?? '[none]');

    const text = [
      draft.type === 'email' ? '📧 New Email Draft' : '🪝 New Webhook Draft',
      '',
      `From: ${payload.from ?? '[n/a]'}`,
      `To: ${to}`,
      `Subject: ${payload.subject ?? '[n/a]'}`,
      '',
      '─────────────',
      preview(bodyPreview, 700),
      '─────────────',
      '',
      `Source: ${draft.source}`,
      `Context: ${draft.metadata.context || '[none]'}`,
      `Priority: ${draft.metadata.priority || 'normal'}`
    ].join('\n');

    const callbackToken = sha256short(fileName);
    this.callbackFileIndex.set(callbackToken, fileName);
    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `approve:${callbackToken}:${draftHash}`)
      .text('❌ Deny', `deny:${callbackToken}`);

    for (const userId of this.config.telegram.allowedUsers) {
      await this.bot.api.sendMessage(userId, text, {
        reply_markup: keyboard
      });
    }
  }

  private async resolvePendingFileName(callbackToken: string): Promise<string | null> {
    const knownFile = this.callbackFileIndex.get(callbackToken);
    if (knownFile) {
      return knownFile;
    }

    const pendingDir = resolve(this.draftsRoot, 'pending');
    let entries: string[];
    try {
      entries = await readdir(pendingDir);
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const token = sha256short(entry);
      this.callbackFileIndex.set(token, entry);
      if (token === callbackToken) {
        return entry;
      }
    }

    return null;
  }
}
