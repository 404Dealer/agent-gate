import type { Draft } from '../schema.js';
import type { Provider, ProviderResult } from './index.js';

export class LogOnlyProvider implements Provider {
  constructor(private readonly fromAddress = 'log-only@example.invalid') {}

  describeSender(): string {
    return `${this.fromAddress} (log-only; no external action)`;
  }

  async send(draft: Draft): Promise<ProviderResult> {
    // eslint-disable-next-line no-console
    console.log('[log-only] Dry run payload:', JSON.stringify(draft.payload, null, 2));
    return { details: 'Dry run only. No external action performed.' };
  }
}
