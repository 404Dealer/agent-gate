import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import {
  selectAuthoritativeMailbox,
  type CleanupMailboxConnection,
  type CleanupTarget,
  type MailboxDescriptor,
  type MailboxUidSnapshot
} from './cleanup.js';
import type { GmailCleanupCredentials } from './config.js';

export function buildGmailImapOptions(credentials: GmailCleanupCredentials): ImapFlowOptions {
  return {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    servername: 'imap.gmail.com',
    auth: { user: credentials.username, pass: credentials.password },
    tls: {
      servername: 'imap.gmail.com',
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2'
    },
    disableAutoIdle: true,
    disableCompression: true,
    logger: false,
    logRaw: false,
    emitLogs: false,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 30_000,
    maxLineLength: 1_048_576,
    maxLiteralSize: 1_048_576,
    maxLockHoldTime: 15_000
  };
}

interface GmailListEntry {
  path: string;
  flags: Set<string>;
}

interface GmailSearchQuery {
  seen: boolean;
  uid?: string;
}

export interface GmailImapClient {
  mailbox: false | { uidValidity: bigint };
  on(event: 'error', listener: (error: Error) => void): this;
  connect(): Promise<void>;
  list(): Promise<ReadonlyArray<GmailListEntry>>;
  getMailboxLock(
    path: string,
    options: { readOnly: boolean }
  ): Promise<{ path: string; release(): void }>;
  search(query: GmailSearchQuery, options: { uid: true }): Promise<number[] | false>;
  messageFlagsAdd(
    uids: readonly number[],
    flags: string[],
    options: { uid: true }
  ): Promise<boolean>;
  logout(): Promise<void>;
  close(): void;
}

export type GmailImapClientFactory = (options: ImapFlowOptions) => GmailImapClient;

const defaultClientFactory: GmailImapClientFactory = (options) =>
  new ImapFlow(options) as GmailImapClient;

export class GmailImapCleanupConnection implements CleanupMailboxConnection {
  private readonly client: GmailImapClient;
  private clientFailed = false;

  constructor(
    credentials: GmailCleanupCredentials,
    clientFactory: GmailImapClientFactory = defaultClientFactory
  ) {
    this.client = clientFactory(buildGmailImapOptions(credentials));
    this.client.on('error', () => {
      this.clientFailed = true;
    });
  }

  private async checked<T>(operation: () => Promise<T>): Promise<T> {
    try {
      if (this.clientFailed) throw new Error('connection unavailable');
      const result = await operation();
      if (this.clientFailed) throw new Error('connection unavailable');
      return result;
    } catch {
      throw new Error('Gmail IMAP operation failed');
    }
  }

  private async rawMailboxes(): Promise<MailboxDescriptor[]> {
    const entries = await this.client.list();
    return entries.map(({ path, flags }) => ({ path, flags: [...flags] }));
  }

  async connect(): Promise<void> {
    await this.checked(() => this.client.connect());
  }

  async listMailboxes(): Promise<readonly MailboxDescriptor[]> {
    return this.checked(() => this.rawMailboxes());
  }

  async snapshotUnread(path: string): Promise<MailboxUidSnapshot> {
    return this.checked(async () => {
      const lock = await this.client.getMailboxLock(path, { readOnly: true });
      try {
        const mailbox = this.client.mailbox;
        if (!mailbox) throw new Error('mailbox selection failed');
        const uids = await this.client.search({ seen: false }, { uid: true });
        if (!Array.isArray(uids)) throw new Error('UID SEARCH failed');
        return { uidValidity: mailbox.uidValidity.toString(), uids: [...uids] };
      } finally {
        lock.release();
      }
    });
  }

  async markSeen(
    target: CleanupTarget,
    path: string,
    expectedUidValidity: string,
    uids: readonly number[]
  ): Promise<number> {
    if (uids.length === 0) return 0;
    return this.checked(async () => {
      const lock = await this.client.getMailboxLock(path, { readOnly: false });
      try {
        const authoritative = selectAuthoritativeMailbox(await this.rawMailboxes(), target);
        if (authoritative.path !== path) throw new Error('mailbox role changed');

        const mailbox = this.client.mailbox;
        if (!mailbox || mailbox.uidValidity.toString() !== expectedUidValidity) {
          throw new Error('mailbox identity changed');
        }

        const approvedUids = [...uids];
        const submitted = await this.client.messageFlagsAdd(approvedUids, ['\\Seen'], { uid: true });
        if (!submitted) return 0;

        const seen = await this.client.search(
          { seen: true, uid: approvedUids.join(',') },
          { uid: true }
        );
        if (!Array.isArray(seen)) return 0;
        const approved = new Set(approvedUids);
        const verified = new Set(
          seen.filter((uid) => Number.isSafeInteger(uid) && approved.has(uid))
        );
        return verified.size;
      } finally {
        lock.release();
      }
    });
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      try {
        this.client.close();
      } catch {
        // The connection is already unusable; never reflect transport diagnostics.
      }
    }
  }
}
