import { Bot, InlineKeyboard } from 'grammy';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { AgentGateConfig } from './config.js';
import type { DraftWatcher } from './watcher.js';
import { DraftSchema, updateStatus, type Draft } from './schema.js';
import { Executor } from './executor.js';

const preview = (value: string, limit = 500): string => (value.length > limit ? `${value.slice(0, limit)}...` : value);

export class AgentGateBot {
  private readonly bot: Bot;

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
      await ctx.reply('🔐 *agent\\-gate* is active\\.\n\nDraft approvals will appear here\\. Only authorized users can approve or deny\\.', { parse_mode: 'MarkdownV2' });
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

    this.bot.callbackQuery(/^(approve|deny):(.+)$/, async (ctx) => {
      const fromId = ctx.from?.id;
      if (!fromId || !this.config.telegram.allowedUsers.includes(fromId)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized', show_alert: true });
        return;
      }

      const action = ctx.match[1];
      const fileName = ctx.match[2];
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
      const draft = DraftSchema.parse(JSON.parse(raw));

      const originalText = ctx.callbackQuery.message?.text ?? '';
      const shortId = draft.id.slice(0, 8);
      const subjectLine = (draft.payload as { subject?: string }).subject ?? 'Untitled';
      const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true });

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
        const statusLine = `\n\n✅ *APPROVED* at ${timestamp}`;
        await ctx.editMessageText(originalText + statusLine, { parse_mode: 'Markdown' }).catch(() => {});

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
        const statusLine = `\n\n❌ *DENIED* at ${timestamp}`;
        await ctx.editMessageText(originalText + statusLine, { parse_mode: 'Markdown' }).catch(() => {});
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

    const bodyPreview = payload.body ? preview(payload.body) : '[no body]';
    const to = Array.isArray(payload.to) ? payload.to.join(', ') : (payload.to ?? '[none]');

    const text = [
      draft.type === 'email' ? '📧 *New Email Draft*' : '🪝 *New Webhook Draft*',
      '',
      `*From:* ${payload.from ?? '[n/a]'}`,
      `*To:* ${to}`,
      `*Subject:* ${payload.subject ?? '[n/a]'}`,
      '',
      '─────────────',
      preview(bodyPreview, 700),
      '─────────────',
      '',
      `*Source:* ${draft.source}`,
      `*Context:* ${draft.metadata.context || '[none]'}`,
      `*Priority:* ${draft.metadata.priority || 'normal'}`
    ].join('\n');

    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `approve:${fileName}`)
      .text('❌ Deny', `deny:${fileName}`);

    for (const userId of this.config.telegram.allowedUsers) {
      const sent = await this.bot.api.sendMessage(userId, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });

      const draftPath = resolve(this.draftsRoot, 'pending', fileName);
      const raw = await readFile(draftPath, 'utf8');
      const currentDraft = DraftSchema.parse(JSON.parse(raw));
      const patched = updateStatus(currentDraft, currentDraft.status, {
        approval: {
          ...currentDraft.approval,
          telegramMessageId: sent.message_id
        }
      });
      await writeFile(draftPath, JSON.stringify(patched, null, 2), 'utf8');
    }
  }
}
