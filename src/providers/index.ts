import type { ProviderConfig } from '../config.js';
import type { Draft } from '../schema.js';
import { LogOnlyProvider } from './log-only.js';
import { ZohoEmailProvider } from './email-zoho.js';

export interface ProviderResult {
  providerMessageId?: string;
  details?: string;
}

export interface Provider {
  send(draft: Draft): Promise<ProviderResult>;
  describeSender(): string;
}

export function createProvider(config: ProviderConfig): Provider {
  if (config.type === 'log-only') return new LogOnlyProvider(config.fromAddress);
  if (config.type === 'email-zoho') return new ZohoEmailProvider(config);
  throw new Error(`Unsupported provider type: ${(config as { type?: string }).type ?? 'unknown'}`);
}
