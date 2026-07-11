import { ImapFlow, type CopyResponseObject, type FetchMessageObject } from 'imapflow';
import { buildGmailImapOptions } from '../mailbox/gmail-imap.js';
import { selectAuthoritativeMailbox } from '../mailbox/cleanup.js';
import type { MailboxTrashDraft } from '../schema.js';
import type { BrokerCredentials } from './gmail-inbox.js';
import { decodeUniqueGmailInboxReferences } from './reference.js';

class SafeTrashError extends Error {}

export class NativeMoveOnlyImapFlow extends ImapFlow {
  override async messageCopy(..._args: Parameters<ImapFlow['messageCopy']>): Promise<never> {
    throw new SafeTrashError('Unsafe IMAP MOVE fallback was blocked');
  }

  override async messageDelete(..._args: Parameters<ImapFlow['messageDelete']>): Promise<never> {
    throw new SafeTrashError('Unsafe IMAP delete/expunge path was blocked');
  }
}

export interface TrashPreviewItem {
  uid?: number;
  messageId?: string;
  from: string;
  subject: string;
  receivedAt: string | null;
  size: number | null;
}

export interface GmailMailboxTrashSnapshot {
  backend: 'gmail';
  provider: string;
  profile: string;
  account: string;
  sourcePath: 'INBOX';
  trashPath: string;
  uidValidity: string;
  uids: number[];
  items: TrashPreviewItem[];
}

export interface OutlookMailboxTrashSnapshot {
  backend: 'outlook';
  provider: string;
  profile: string;
  account: string;
  sourcePath: 'Inbox';
  trashPath: 'Deleted Items';
  messageIds: string[];
  items: TrashPreviewItem[];
}

export type MailboxTrashSnapshot = GmailMailboxTrashSnapshot | OutlookMailboxTrashSnapshot;

export type MailboxTrashResult =
  | { outcome: 'moved'; requestedCount: number; verifiedMovedCount: number; details: string }
  | { outcome: 'move-partial'; requestedCount: number; verifiedMovedCount: number; details: string };

export function classifyMailboxMoveResult(
  snapshot: GmailMailboxTrashSnapshot,
  result: CopyResponseObject | false
): MailboxTrashResult {
  if (!result || result.path !== snapshot.sourcePath || result.destination !== snapshot.trashPath || !(result.uidMap instanceof Map)) {
    return {
      outcome: 'move-partial',
      requestedCount: snapshot.uids.length,
      verifiedMovedCount: 0,
      details: 'Gmail MOVE returned no authoritative UID mapping; do not retry automatically'
    };
  }
  const verifiedMovedCount = snapshot.uids.filter((uid) => {
    const destinationUid = result.uidMap?.get(uid);
    return Number.isSafeInteger(destinationUid) && destinationUid! > 0;
  }).length;
  return verifiedMovedCount === snapshot.uids.length
    ? {
        outcome: 'moved',
        requestedCount: snapshot.uids.length,
        verifiedMovedCount,
        details: `Moved ${verifiedMovedCount} message(s) to Gmail Trash with authoritative UID mapping`
      }
    : {
        outcome: 'move-partial',
        requestedCount: snapshot.uids.length,
        verifiedMovedCount,
        details: 'Gmail MOVE returned a partial UID mapping; do not retry automatically'
      };
}

const cleanLine = (value: unknown, max = 300): string =>
  (typeof value === 'string' ? value : '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const displayAddress = (message: FetchMessageObject): string => {
  const first = message.envelope?.from?.[0];
  if (!first) return '[unknown sender]';
  const name = cleanLine(first.name, 200);
  const address = cleanLine(first.address, 320);
  return name && address ? `${name} <${address}>` : (address || name || '[unknown sender]');
};

const dateIso = (message: FetchMessageObject): string | null => {
  const date = message.envelope?.date ?? message.internalDate;
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const exactFetched = (fetched: FetchMessageObject[], uids: readonly number[]): Map<number, FetchMessageObject> => {
  const wanted = new Set(uids);
  const byUid = new Map(
    fetched
      .filter((message) => wanted.has(message.uid))
      .map((message) => [message.uid, message] as const)
  );
  if (byUid.size !== wanted.size) throw new SafeTrashError('One or more messages are no longer in INBOX');
  return byUid;
};

export class GmailMailboxTrashService {
  constructor(
    private readonly credentials: BrokerCredentials,
    private readonly profile = 'default',
    private readonly providerName = 'gmail-smtp',
    private readonly address = credentials.username
  ) {}

  private assertProfile(refs: ReturnType<typeof decodeUniqueGmailInboxReferences>): void {
    if (refs.some((ref) => ref.v === 2 ? ref.profile !== this.profile : this.providerName !== 'gmail-smtp')) {
      throw new SafeTrashError('Mailbox reference belongs to a different profile');
    }
  }

  private async withClient<T>(operation: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new NativeMoveOnlyImapFlow(buildGmailImapOptions(this.credentials));
    client.on('error', () => {});
    try {
      await client.connect();
      return await operation(client);
    } catch (error) {
      if (error instanceof SafeTrashError) throw error;
      throw new Error('Gmail mailbox operation failed');
    } finally {
      try {
        if (client.usable) await client.logout();
        else client.close();
      } catch {
        client.close();
      }
    }
  }

  async prepare(draft: MailboxTrashDraft): Promise<MailboxTrashSnapshot> {
    if (draft.provider !== this.providerName) throw new SafeTrashError('Mailbox reference belongs to a different profile');
    const refs = decodeUniqueGmailInboxReferences(draft.payload.refs);
    this.assertProfile(refs);
    const uidValidity = refs[0].uidValidity;
    const uids = refs.map((ref) => ref.uid);

    return this.withClient(async (client) => {
      if (!client.capabilities.has('MOVE') || !client.capabilities.has('UIDPLUS')) {
        throw new SafeTrashError('Gmail server does not advertise safe MOVE and UIDPLUS support');
      }
      const mailboxes = (await client.list()).map((mailbox) => ({ path: mailbox.path, flags: [...mailbox.flags] }));
      const trash = selectAuthoritativeMailbox(mailboxes, 'trash');
      const lock = await client.getMailboxLock('INBOX', { readOnly: true, acquireTimeout: 10_000 });
      try {
        if (!client.mailbox || client.mailbox.uidValidity.toString() !== uidValidity) {
          throw new SafeTrashError('One or more message references are stale');
        }
        const fetched = await client.fetchAll(
          uids,
          { uid: true, envelope: true, internalDate: true, size: true },
          { uid: true }
        );
        const byUid = exactFetched(fetched, uids);
        return {
          backend: 'gmail',
          provider: this.providerName,
          profile: this.profile,
          account: cleanLine(this.address, 320),
          sourcePath: 'INBOX',
          trashPath: trash.path,
          uidValidity,
          uids,
          items: uids.map((uid) => {
            const message = byUid.get(uid)!;
            return {
              uid,
              from: displayAddress(message),
              subject: cleanLine(message.envelope?.subject, 300) || '[no subject]',
              receivedAt: dateIso(message),
              size: Number.isSafeInteger(message.size) ? message.size! : null
            };
          })
        };
      } finally {
        lock.release();
      }
    });
  }

  async execute(snapshot: MailboxTrashSnapshot): Promise<MailboxTrashResult> {
    if (snapshot.backend !== 'gmail' || snapshot.provider !== this.providerName || snapshot.profile !== this.profile || snapshot.account !== cleanLine(this.address, 320)) {
      throw new SafeTrashError('Mailbox reference belongs to a different profile');
    }
    return this.withClient(async (client) => {
      if (!client.capabilities.has('MOVE') || !client.capabilities.has('UIDPLUS')) {
        throw new SafeTrashError('Gmail server does not advertise safe MOVE and UIDPLUS support');
      }
      const mailboxes = (await client.list()).map((mailbox) => ({ path: mailbox.path, flags: [...mailbox.flags] }));
      const trash = selectAuthoritativeMailbox(mailboxes, 'trash');
      if (trash.path !== snapshot.trashPath) throw new SafeTrashError('Gmail Trash identity changed after approval');

      const lock = await client.getMailboxLock(snapshot.sourcePath, { readOnly: false, acquireTimeout: 10_000 });
      try {
        if (!client.mailbox || client.mailbox.uidValidity.toString() !== snapshot.uidValidity) {
          throw new SafeTrashError('One or more message references became stale after approval');
        }
        exactFetched(
          await client.fetchAll(snapshot.uids, { uid: true }, { uid: true }),
          snapshot.uids
        );

        if (!client.capabilities.has('MOVE') || !client.capabilities.has('UIDPLUS')) {
          throw new SafeTrashError('Gmail safe MOVE capabilities changed before execution');
        }

        let result: Awaited<ReturnType<ImapFlow['messageMove']>>;
        try {
          result = await client.messageMove(snapshot.uids, snapshot.trashPath, { uid: true });
        } catch {
          return {
            outcome: 'move-partial',
            requestedCount: snapshot.uids.length,
            verifiedMovedCount: 0,
            details: 'Gmail MOVE outcome could not be confirmed; do not retry automatically'
          };
        }
        return classifyMailboxMoveResult(snapshot, result);
      } finally {
        lock.release();
      }
    });
  }
}
