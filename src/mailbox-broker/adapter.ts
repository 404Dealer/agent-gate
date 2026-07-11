import type { InboxListResult, InboxMessage } from './gmail-inbox.js';

export interface MailboxMarkReadResult {
  outcome: 'applied' | 'partial';
  requested: number;
  verified: number;
}

export interface MailboxAdapter {
  readonly profile: string;
  readonly providerName: string;
  readonly backend: 'gmail' | 'outlook';
  readonly address: string;
  list(unread: boolean, limit: number): Promise<InboxListResult>;
  read(encodedReference: string): Promise<InboxMessage>;
  markRead(encodedReferences: string[]): Promise<MailboxMarkReadResult>;
}
