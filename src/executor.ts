import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { AgentGateConfig } from './config.js';
import { DraftSchema, updateStatus, type Draft } from './schema.js';
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
    });

export class Executor {
  private readonly providers: Record<string, Provider>;

  constructor(
    private readonly config: AgentGateConfig,
    private readonly draftsRoot: string,
    providerOverrides?: Record<string, Provider>
  ) {
    this.providers = providerOverrides ?? Object.fromEntries(
      Object.entries(config.providers).map(([name, providerConfig]) => [name, createProvider(providerConfig)])
    );
  }

  describeProviderSender(providerName: string): string {
    const provider = this.providers[providerName];
    if (!provider) return `[provider not configured: ${providerName}]`;
    return provider.describeSender();
  }

  async executeApprovedDraft(filePath: string): Promise<ExecutionResult> {
    const raw = await readFile(filePath, 'utf8');
    const draft = DraftSchema.parse(JSON.parse(raw));
    const providerName = draft.provider || this.config.defaults.provider;
    const provider = this.providers[providerName];

    if (!provider) {
      throw new Error(`Provider not configured: ${providerName}`);
    }

    let result: ProviderResult;
    try {
      result = await provider.send(draft);
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
        // A local bookkeeping failure must not replace the fixed provider error.
      }
      throw new Error(safeError);
    }

    const executionResult = this.toExecutionResult(result);
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
        result.providerMessageId,
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
    action: 'sent' | 'partial' | 'failed',
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
        : {})
    });
    await appendFile(this.config.audit.logFile, `${line}\n`, 'utf8');
  }
}
