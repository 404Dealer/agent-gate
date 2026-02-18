import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { AgentGateConfig } from './config.js';
import { DraftSchema, updateStatus, type Draft } from './schema.js';
import { ProviderRegistry } from './providers/index.js';
import { LogOnlyProvider } from './providers/log-only.js';
import { ZohoEmailProvider } from './providers/email-zoho.js';

export class Executor {
  private readonly registry = new ProviderRegistry();

  constructor(private readonly config: AgentGateConfig, private readonly draftsRoot: string) {
    for (const [name, providerConfig] of Object.entries(config.providers)) {
      if (providerConfig.type === 'log-only') {
        this.registry.register(name, new LogOnlyProvider());
      }
      if (providerConfig.type === 'email-zoho') {
        this.registry.register(name, new ZohoEmailProvider(providerConfig));
      }
    }
  }

  async executeApprovedDraft(filePath: string): Promise<void> {
    const raw = await readFile(filePath, 'utf8');
    const draft = DraftSchema.parse(JSON.parse(raw));
    const providerName = draft.provider || this.config.defaults.provider;

    try {
      const provider = this.registry.get(providerName);
      const result = await provider.send(draft, { config: this.config });

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
      const failedDraft = updateStatus(draft, 'failed', {
        approval: {
          ...draft.approval,
          error: error instanceof Error ? error.message : String(error)
        }
      });

      const failedPath = resolve(this.draftsRoot, 'failed', basename(filePath));
      await writeFile(filePath, JSON.stringify(failedDraft, null, 2), 'utf8');
      await rename(filePath, failedPath);
      await this.appendAudit('failed', failedDraft, failedDraft.approval.error ?? 'Unknown error');
      throw error;
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
