import type { ProviderConfig } from '../config.js';
import type { Draft } from '../schema.js';
import { GmailEmailProvider } from './email-gmail.js';
import { LogOnlyProvider } from './log-only.js';
import { OutlookEmailProvider } from './email-outlook.js';
import { SmtpEmailProvider } from './email-smtp.js';
import { ZohoEmailProvider } from './email-zoho.js';

interface ProviderResultBase {
  providerMessageId?: string;
  details?: string;
}

export type ProviderResult =
  | (ProviderResultBase & { outcome?: 'sent' })
  | (ProviderResultBase & {
      outcome: 'partial';
      acceptedCount: number;
      rejectedCount: number;
      rejectedRecipients: string[];
    });

export interface Provider {
  send(draft: Draft): Promise<ProviderResult>;
  describeSender(): string;
}

export function createProvider(config: ProviderConfig): Provider {
  if (config.type === 'log-only') return new LogOnlyProvider(config.fromAddress);
  if (config.type === 'email-smtp') return new SmtpEmailProvider(config);
  if (config.type === 'email-gmail') return new GmailEmailProvider(config);
  if (config.type === 'email-outlook') return new OutlookEmailProvider(config);
  if (config.type === 'email-zoho') return new ZohoEmailProvider(config);
  throw new Error(`Unsupported provider type: ${(config as { type?: string }).type ?? 'unknown'}`);
}
