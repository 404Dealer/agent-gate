import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { AgentGateConfig } from '../config.js';
import { buildGmailImapOptions } from '../mailbox/gmail-imap.js';
import { decodeInboxReference, encodeInboxReference } from './reference.js';

const MAX_MESSAGE_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_LIST_SCAN_UIDS = 500;

class SafeMailboxError extends Error {}

export interface BrokerCredentials {
  username: string;
  password: string;
}

export interface InboxListItem {
  ref: string;
  uid: number;
  unread: boolean;
  flagged: boolean;
  from: string;
  subject: string;
  receivedAt: string | null;
  size: number | null;
}

export interface InboxListResult {
  items: InboxListItem[];
  scannedUidWindow: number;
  truncated: boolean;
}

export interface InboxMessage extends InboxListItem {
  to: string[];
  cc: string[];
  text: string;
  html: string | null;
  attachments: Array<{ filename: string | null; contentType: string; size: number }>;
}

const cleanLine = (value: unknown, max = 500): string =>
  (typeof value === 'string' ? value : '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const cleanBody = (value: unknown): string => {
  const body = (typeof value === 'string' ? value : '').replace(/\u0000/g, '');
  const encoded = Buffer.from(body, 'utf8');
  return encoded.length <= MAX_BODY_BYTES
    ? body
    : encoded.subarray(0, MAX_BODY_BYTES).toString('utf8');
};

const addresses = (values: Array<{ name?: string; address?: string }> | undefined): string[] =>
  (values ?? []).slice(0, 50).map((entry) => {
    const name = cleanLine(entry.name, 200);
    const address = cleanLine(entry.address, 320);
    return name && address ? `${name} <${address}>` : (address || name);
  }).filter(Boolean);

const dateString = (message: FetchMessageObject): string | null => {
  const value = message.envelope?.date ?? message.internalDate;
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
};

const listItem = (message: FetchMessageObject, uidValidity: string): InboxListItem => {
  const flags = message.flags ?? new Set<string>();
  return {
    ref: encodeInboxReference({ uidValidity, uid: message.uid }),
    uid: message.uid,
    unread: !flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    from: addresses(message.envelope?.from)[0] ?? '',
    subject: cleanLine(message.envelope?.subject, 500),
    receivedAt: dateString(message),
    size: Number.isSafeInteger(message.size) ? message.size! : null
  };
};

export function credentialsFromConfig(config: AgentGateConfig): BrokerCredentials | null {
  const provider = config.providers['gmail-smtp'];
  if (
    !provider ||
    provider.type !== 'email-smtp' ||
    provider.host !== 'smtp.gmail.com' ||
    provider.port !== 465 ||
    provider.tlsMode !== 'implicit' ||
    provider.username.toLowerCase() !== provider.fromAddress.toLowerCase()
  ) {
    return null;
  }
  return { username: provider.username, password: provider.password };
}

export class GmailInboxBroker {
  constructor(private readonly credentials: BrokerCredentials) {}

  private async withClient<T>(operation: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow(buildGmailImapOptions(this.credentials));
    let failed = false;
    client.on('error', () => { failed = true; });
    try {
      await client.connect();
      if (failed) throw new Error('connection unavailable');
      const result = await operation(client);
      if (failed) throw new Error('connection unavailable');
      return result;
    } catch (error) {
      if (error instanceof SafeMailboxError) throw error;
      throw new Error('Gmail mailbox operation failed');
    } finally {
      try {
        await client.logout();
      } catch {
        try { client.close(); } catch { /* already closed */ }
      }
    }
  }

  async list(unread: boolean, limit: number): Promise<InboxListResult> {
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true, acquireTimeout: 10_000 });
      try {
        if (!client.mailbox) throw new Error('mailbox unavailable');
        const upper = client.mailbox.uidNext - 1;
        if (!Number.isSafeInteger(upper) || upper < 1) {
          return { items: [], scannedUidWindow: 0, truncated: false };
        }
        const lower = Math.max(1, upper - MAX_LIST_SCAN_UIDS + 1);
        const fetched = await client.fetchAll(
          `${lower}:${upper}`,
          { uid: true, flags: true, envelope: true, internalDate: true, size: true },
          { uid: true }
        );
        const uidValidity = client.mailbox.uidValidity.toString();
        const items = fetched
          .filter((message) => Number.isSafeInteger(message.uid) && message.uid > 0)
          .filter((message) => !unread || !(message.flags ?? new Set<string>()).has('\\Seen'))
          .sort((a, b) => b.uid - a.uid)
          .slice(0, limit)
          .map((message) => listItem(message, uidValidity));
        return {
          items,
          scannedUidWindow: upper - lower + 1,
          truncated: lower > 1
        };
      } finally {
        lock.release();
      }
    });
  }

  async read(encodedReference: string): Promise<InboxMessage> {
    const reference = decodeInboxReference(encodedReference);
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true, acquireTimeout: 10_000 });
      try {
        if (!client.mailbox || client.mailbox.uidValidity.toString() !== reference.uidValidity) {
          throw new SafeMailboxError('Message reference is stale');
        }
        const metadata = await client.fetchOne(
          reference.uid,
          { uid: true, flags: true, envelope: true, internalDate: true, size: true },
          { uid: true }
        );
        if (!metadata || metadata.uid !== reference.uid) throw new SafeMailboxError('Message is no longer in INBOX');
        if (!Number.isSafeInteger(metadata.size) || metadata.size! > MAX_MESSAGE_BYTES) {
          throw new SafeMailboxError('Message is too large to read through the mailbox broker');
        }
        const fetched = await client.fetchOne(
          reference.uid,
          { uid: true, flags: true, envelope: true, internalDate: true, size: true, source: { start: 0, maxLength: MAX_MESSAGE_BYTES + 1 } },
          { uid: true }
        );
        if (!fetched || fetched.uid !== reference.uid || !fetched.source || fetched.source.length > MAX_MESSAGE_BYTES) {
          throw new SafeMailboxError('Message could not be read safely');
        }
        const parsed = await simpleParser(fetched.source, { skipImageLinks: true });
        const text = cleanBody(parsed.text);
        return {
          ...listItem(fetched, reference.uidValidity),
          to: addresses(fetched.envelope?.to),
          cc: addresses(fetched.envelope?.cc),
          text,
          html: text ? null : (typeof parsed.html === 'string' ? cleanBody(parsed.html) : null),
          attachments: parsed.attachments.slice(0, 50).map((attachment) => ({
            filename: cleanLine(attachment.filename, 300) || null,
            contentType: cleanLine(attachment.contentType, 200),
            size: Number.isSafeInteger(attachment.size) ? attachment.size : attachment.content.length
          }))
        };
      } finally {
        lock.release();
      }
    });
  }

  async markRead(encodedReferences: string[]): Promise<{ requested: number; verified: number }> {
    const references = encodedReferences.map(decodeInboxReference);
    const unique = new Map(references.map((reference) => [reference.uid, reference]));
    const exact = [...unique.values()];
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock('INBOX', { readOnly: false, acquireTimeout: 10_000 });
      try {
        if (!client.mailbox) throw new Error('mailbox unavailable');
        const uidValidity = client.mailbox.uidValidity.toString();
        if (exact.some((reference) => reference.uidValidity !== uidValidity)) {
          throw new SafeMailboxError('One or more message references are stale');
        }
        const uids = exact.map((reference) => reference.uid);
        const present = await client.search({ uid: uids.join(',') }, { uid: true });
        if (!Array.isArray(present) || new Set(present).size !== uids.length) {
          throw new SafeMailboxError('One or more messages are no longer in INBOX');
        }
        const submitted = await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
        if (!submitted) throw new Error('store failed');
        const seen = await client.search({ uid: uids.join(','), seen: true }, { uid: true });
        if (!Array.isArray(seen)) throw new Error('verification failed');
        const approved = new Set(uids);
        const verified = new Set(seen.filter((uid) => approved.has(uid))).size;
        return {
          outcome: verified === uids.length ? 'applied' as const : 'partial' as const,
          requested: uids.length,
          verified
        };
      } finally {
        lock.release();
      }
    });
  }
}
