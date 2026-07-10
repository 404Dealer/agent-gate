import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { AgentGateConfig } from './config.js';
import { DraftSchema, updateStatus, type Draft } from './schema.js';
import { createProvider, type Provider, type ProviderResult } from './providers/index.js';

const sanitizeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
};

export interface ExecutionResult {
  outcome: 'sent' | 'partial';
  details: string;
  acceptedCount?: number;
  rejectedCount?: number;
  rejectedRecipients?: string[];
}

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

    try {
      const result = await provider.send(draft);

      const sentDraft = updateStatus(draft, 'sent', {
        approval: {
          ...draft.approval,
          error: undefined
        }
      });

      const sentPath = resolve(this.draftsRoot, 'sent', basename(filePath));
      await writeFile(filePath, JSON.stringify(sentDraft, null, 2), 'utf8');
      await rename(filePath, sentPath);
      const executionResult = this.toExecutionResult(result);
      await this.appendAudit(
        executionResult.outcome,
        sentDraft,
        executionResult.details,
        result.providerMessageId,
        executionResult
      );
      return executionResult;
    } catch (error) {
      const safeError = sanitizeError(error);
      const failedDraft = updateStatus(draft, 'failed', {
        approval: {
          ...draft.approval,
          error: safeError
        }
      });

      const failedPath = resolve(this.draftsRoot, 'failed', basename(filePath));
      await writeFile(filePath, JSON.stringify(failedDraft, null, 2), 'utf8');
      await rename(filePath, failedPath);
      await this.appendAudit('failed', failedDraft, safeError);
      throw new Error(safeError);
    }
  }

  private toExecutionResult(result: ProviderResult): ExecutionResult {
    const outcome = result.outcome === 'partial' ? 'partial' : 'sent';
    return {
      outcome,
      details: sanitizeError(result.details ?? ''),
      ...(outcome === 'partial'
        ? {
            acceptedCount: result.acceptedCount ?? 0,
            rejectedCount: result.rejectedCount ?? 0,
            rejectedRecipients: [...(result.rejectedRecipients ?? [])]
          }
        : {})
    };
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
