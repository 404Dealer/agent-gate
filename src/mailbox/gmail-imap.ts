import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type { CleanupMailboxConnection, MailboxDescriptor, MailboxUidSnapshot } from './cleanup.js';
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

export interface GmailImapClient {
  mailbox: false | { uidValidity: bigint };
  connect(): Promise<void>;
  list(): Promise<readonly Array<{ path: string; specialUse?: string }>[number][]>;
  getMailboxLock(
    path: string,
    options: { readOnly: boolean }
  ): Promise<{ path: string; release(): void }>;
  search(query: { seen: boolean }, options: { uid: true }): Promise<number[] | false>;
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

  constructor(
    credentials: GmailCleanupCredentials,
    clientFactory: GmailImapClientFactory = defaultClientFactory
  ) {
    this.client = clientFactory(buildGmailImapOptions(credentials));
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async listMailboxes(): Promise<readonly MailboxDescriptor[]> {
    return (await this.client.list()).map(({ path, specialUse }) => ({ path, specialUse }));
  }

  async snapshotUnread(path: string): Promise<MailboxUidSnapshot> {
    const lock = await this.client.getMailboxLock(path, { readOnly: true });
    try {
      const mailbox = this.client.mailbox;
      if (!mailbox) throw new Error('Gmail mailbox selection failed');
      const uids = await this.client.search({ seen: false }, { uid: true });
      return { uidValidity: mailbox.uidValidity.toString(), uids: uids || [] };
    } finally {
      lock.release();
    }
  }

  async markSeen(
    path: string,
    expectedUidValidity: string,
    uids: readonly number[]
  ): Promise<number> {
    const lock = await this.client.getMailboxLock(path, { readOnly: false });
    try {
      const mailbox = this.client.mailbox;
      if (!mailbox || mailbox.uidValidity.toString() !== expectedUidValidity) {
        throw new Error('Gmail mailbox identity changed before cleanup');
      }
      const applied = await this.client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
      return applied ? uids.length : 0;
    } finally {
      lock.release();
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}
