import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { AgentGateConfig } from './config.js';
import { credentialsFromConfig } from './mailbox-broker/gmail-inbox.js';
import {
  GmailMailboxTrashService,
  type MailboxTrashResult,
  type MailboxTrashSnapshot
} from './mailbox-broker/gmail-trash.js';
import {
  GmailUnsubscribeService,
  type MailboxUnsubscribeResult,
  type MailboxUnsubscribeSnapshot
} from './mailbox-broker/gmail-unsubscribe.js';
import {
  DraftSchema,
  updateStatus,
  type Draft,
  type MailboxTrashDraft,
  type MailboxUnsubscribeDraft
} from './schema.js';
import { createProvider, type Provider, type ProviderResult } from './providers/index.js';

const sanitizeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
};

interface ExecutionResultBase {
  details: string;
  persistenceWarning?: boolean;
}

export type ExecutionResult =
  | (ExecutionResultBase & { outcome: 'sent' })
  | (ExecutionResultBase & {
      outcome: 'partial';
      acceptedCount: number;
      rejectedCount: number;
      rejectedRecipients: string[];
    })
  | (ExecutionResultBase & {
      outcome: 'moved' | 'move-partial';
      requestedCount: number;
      verifiedMovedCount: number;
    })
  | (ExecutionResultBase & {
      outcome: 'unsubscribe-accepted' | 'unsubscribe-rejected' | 'unsubscribe-ambiguous';
      method: 'https' | 'mailto';
      destination: string;
    });

export interface MailboxTrashExecutor {
  prepare(draft: MailboxTrashDraft): Promise<MailboxTrashSnapshot>;
  execute(snapshot: MailboxTrashSnapshot): Promise<MailboxTrashResult>;
}

export interface MailboxUnsubscribeExecutor {
  prepare(draft: MailboxUnsubscribeDraft): Promise<MailboxUnsubscribeSnapshot>;
  executeHttps(snapshot: Extract<MailboxUnsubscribeSnapshot, { method: 'rfc8058-https-post' }>): Promise<MailboxUnsubscribeResult>;
}

export class Executor {
  private readonly providers: Record<string, Provider>;
  private readonly mailboxTrash: MailboxTrashExecutor | null;
  private readonly mailboxUnsubscribe: MailboxUnsubscribeExecutor | null;

  constructor(
    private readonly config: AgentGateConfig,
    private readonly draftsRoot: string,
    providerOverrides?: Record<string, Provider>,
    mailboxTrashOverride?: MailboxTrashExecutor | null,
    mailboxUnsubscribeOverride?: MailboxUnsubscribeExecutor | null
  ) {
    this.providers = providerOverrides ?? Object.fromEntries(
      Object.entries(config.providers).map(([name, providerConfig]) => [name, createProvider(providerConfig)])
    );
    const credentials = credentialsFromConfig(config);
    if (mailboxTrashOverride !== undefined) {
      this.mailboxTrash = mailboxTrashOverride;
    } else {
      this.mailboxTrash = credentials ? new GmailMailboxTrashService(credentials) : null;
    }
    if (mailboxUnsubscribeOverride !== undefined) {
      this.mailboxUnsubscribe = mailboxUnsubscribeOverride;
    } else {
      this.mailboxUnsubscribe = credentials ? new GmailUnsubscribeService(credentials) : null;
    }
  }

  describeProviderSender(providerName: string): string {
    const provider = this.providers[providerName];
    if (!provider) return `[provider not configured: ${providerName}]`;
    return provider.describeSender();
  }

  async prepareMailboxTrash(draft: MailboxTrashDraft): Promise<MailboxTrashSnapshot> {
    if (!this.mailboxTrash) throw new Error('Mailbox Trash is not configured');
    return this.mailboxTrash.prepare(draft);
  }

  async prepareMailboxUnsubscribe(draft: MailboxUnsubscribeDraft): Promise<MailboxUnsubscribeSnapshot> {
    if (!this.mailboxUnsubscribe) throw new Error('Mailbox unsubscribe is not configured');
    return this.mailboxUnsubscribe.prepare(draft);
  }

  async executeApprovedDraft(
    filePath: string,
    mailboxTrashSnapshot?: MailboxTrashSnapshot,
    mailboxUnsubscribeSnapshot?: MailboxUnsubscribeSnapshot
  ): Promise<ExecutionResult> {
    const raw = await readFile(filePath, 'utf8');
    const draft = DraftSchema.parse(JSON.parse(raw));
    let executionResult: ExecutionResult;
    let providerMessageId: string | undefined;

    try {
      if (draft.type === 'mailbox-trash') {
        if (!this.mailboxTrash || !mailboxTrashSnapshot) {
          throw new Error('Approved mailbox snapshot is unavailable');
        }
        executionResult = await this.mailboxTrash.execute(mailboxTrashSnapshot);
      } else if (draft.type === 'mailbox-unsubscribe') {
        if (!this.mailboxUnsubscribe || !mailboxUnsubscribeSnapshot) {
          throw new Error('Approved unsubscribe snapshot is unavailable');
        }
        if (mailboxUnsubscribeSnapshot.method === 'rfc8058-https-post') {
          executionResult = await this.mailboxUnsubscribe.executeHttps(mailboxUnsubscribeSnapshot);
        } else {
          const provider = this.providers[draft.provider];
          if (!provider) throw new Error(`Provider not configured: ${draft.provider}`);
          const syntheticEmail = DraftSchema.parse({
            ...draft,
            type: 'email',
            payload: {
              from: mailboxUnsubscribeSnapshot.account,
              to: mailboxUnsubscribeSnapshot.recipient,
              subject: mailboxUnsubscribeSnapshot.subject,
              body: mailboxUnsubscribeSnapshot.body,
              cc: [],
              bcc: [],
              replyTo: ''
            }
          });
          try {
            const result = await provider.send(syntheticEmail);
            providerMessageId = result.providerMessageId;
            executionResult = {
              outcome: 'unsubscribe-accepted',
              method: 'mailto',
              destination: mailboxUnsubscribeSnapshot.recipient,
              details: 'The standards-based unsubscribe email was accepted by SMTP'
            };
          } catch {
            executionResult = {
              outcome: 'unsubscribe-ambiguous',
              method: 'mailto',
              destination: mailboxUnsubscribeSnapshot.recipient,
              details: 'The unsubscribe email outcome could not be confirmed; do not retry automatically'
            };
          }
        }
      } else {
        const providerName = draft.provider || this.config.defaults.provider;
        const provider = this.providers[providerName];
        if (!provider) throw new Error(`Provider not configured: ${providerName}`);
        const result = await provider.send(draft);
        providerMessageId = result.providerMessageId;
        executionResult = this.toExecutionResult(result);
      }
    } catch (error) {
      const safeError = sanitizeError(error);
      const failedDraft = updateStatus(draft, 'failed', {
        approval: {
          ...draft.approval,
          error: safeError
        }
      });
      try {
        const failedPath = resolve(this.draftsRoot, 'failed', basename(filePath));
        await writeFile(filePath, JSON.stringify(failedDraft, null, 2), 'utf8');
        await rename(filePath, failedPath);
        await this.appendAudit('failed', failedDraft, safeError);
      } catch {
        // A local bookkeeping failure must not replace the fixed execution error.
      }
      throw new Error(safeError);
    }

    const sentDraft = updateStatus(draft, 'sent', {
      approval: {
        ...draft.approval,
        error: undefined
      }
    });

    try {
      const sentPath = resolve(this.draftsRoot, 'sent', basename(filePath));
      await writeFile(filePath, JSON.stringify(sentDraft, null, 2), 'utf8');
      await rename(filePath, sentPath);
      await this.appendAudit(
        executionResult.outcome,
        sentDraft,
        executionResult.details,
        providerMessageId,
        executionResult
      );
      return executionResult;
    } catch {
      return { ...executionResult, persistenceWarning: true };
    }
  }

  private toExecutionResult(result: ProviderResult): ExecutionResult {
    const details = sanitizeError(result.details ?? '');
    if (result.outcome === 'partial') {
      return {
        outcome: 'partial',
        details,
        acceptedCount: result.acceptedCount,
        rejectedCount: result.rejectedCount,
        rejectedRecipients: [...result.rejectedRecipients]
      };
    }
    return { outcome: 'sent', details };
  }

  private async appendAudit(
    action: ExecutionResult['outcome'] | 'failed',
    draft: Draft,
    details: string,
    providerMessageId?: string,
    result?: ExecutionResult
  ): Promise<void> {
    if (!this.config.audit.enabled) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action,
      id: draft.id,
      provider: draft.provider,
      status: draft.status,
      details,
      providerMessageId,
      ...(result?.outcome === 'partial'
        ? {
            acceptedCount: result.acceptedCount,
            rejectedCount: result.rejectedCount,
            rejectedRecipients: result.rejectedRecipients
          }
        : result?.outcome === 'moved' || result?.outcome === 'move-partial'
          ? {
              requestedCount: result.requestedCount,
              verifiedMovedCount: result.verifiedMovedCount
            }
          : result?.outcome === 'unsubscribe-accepted' ||
              result?.outcome === 'unsubscribe-rejected' ||
              result?.outcome === 'unsubscribe-ambiguous'
            ? { method: result.method }
            : {})
    });
    await appendFile(this.config.audit.logFile, `${line}\n`, 'utf8');
  }
}
