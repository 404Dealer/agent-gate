import type { Draft } from '../schema.js';
import type { ExecutionContext, Provider } from './index.js';

export class LogOnlyProvider implements Provider {
  name = 'log-only';

  async send(draft: Draft, _context: ExecutionContext): Promise<{ providerMessageId?: string; details?: string }> {
    // eslint-disable-next-line no-console
    console.log('[log-only] Dry run payload:', JSON.stringify(draft.payload, null, 2));
    return { details: 'Dry run only. No external action performed.' };
  }
}
