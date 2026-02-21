import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { AgentGateConfig } from './config.js';
import { DraftSchema, updateStatus, type Draft } from './schema.js';
import { createProvider, type Provider } from './providers/index.js';

const sanitizeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
};

export class Executor {
  private readonly providers: Record<string, Provider>;

  constructor(private readonly config: AgentGateConfig, private readonly draftsRoot: string) {
    this.providers = Object.fromEntries(
      Object.entries(config.providers).map(([name, providerConfig]) => [name, createProvider(providerConfig)])
    );
  }

  async executeApprovedDraft(filePath: string): Promise<void> {
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
      await this.appendAudit('sent', sentDraft, result.details ?? '', result.providerMessageId);
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

  private async appendAudit(action: 'sent' | 'failed', draft: Draft, details: string, providerMessageId?: string): Promise<void> {
    if (!this.config.audit.enabled) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action,
      id: draft.id,
      provider: draft.provider,
      status: draft.status,
      details,
      providerMessageId
    });
    await appendFile(this.config.audit.logFile, `${line}\n`, 'utf8');
  }
}
