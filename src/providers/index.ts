import type { Draft } from '../schema.js';
import type { AgentGateConfig } from '../config.js';
import type { LogOnlyProvider } from './log-only.js';
import type { ZohoEmailProvider } from './email-zoho.js';

export interface ExecutionContext {
  config: AgentGateConfig;
}

export interface Provider {
  name: string;
  send(draft: Draft, context: ExecutionContext): Promise<{ providerMessageId?: string; details?: string }>;
}

export type ProviderInstance = LogOnlyProvider | ZohoEmailProvider;

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  register(name: string, provider: Provider): void {
    this.providers.set(name, provider);
  }

  get(name: string): Provider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider not registered: ${name}`);
    }
    return provider;
  }
}
