import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { buildGmailImapOptions } from '../mailbox/gmail-imap.js';
import { selectAuthoritativeMailbox } from '../mailbox/cleanup.js';
import type { MailboxTrashDraft } from '../schema.js';
import type { BrokerCredentials } from './gmail-inbox.js';
import { decodeInboxReference } from './reference.js';

class SafeTrashError extends Error {}

export interface TrashPreviewItem {
  uid: number;
  from: string;
  subject: string;
  receivedAt: string | null;
  size: number | null;
}

export interface MailboxTrashSnapshot {
  provider: 'gmail-smtp';
  sourcePath: 'INBOX';
  trashPath: string;
  uidValidity: string;
  uids: number[];
  items: TrashPreviewItem[];
}

export type MailboxTrashResult =
  | { outcome: 'moved'; requestedCount: number; verifiedMovedCount: number; details: string }
  | { outcome: 'move-partial'; requestedCount: number; verifiedMovedCount: number; details: string };

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
  constructor(private readonly credentials: BrokerCredentials) {}

  private async withClient<T>(operation: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow(buildGmailImapOptions(this.credentials));
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
    if (draft.provider !== 'gmail-smtp') throw new SafeTrashError('Mailbox Trash requires the gmail-smtp provider');
    const refs = draft.payload.refs.map((ref) => decodeInboxReference(ref));
    const uidValidity = refs[0]?.uidValidity;
    if (!uidValidity || refs.some((ref) => ref.uidValidity !== uidValidity)) {
      throw new SafeTrashError('Mailbox references must share one current INBOX identity');
    }
    const uids = [...new Set(refs.map((ref) => ref.uid))];

    return this.withClient(async (client) => {
      if (!client.capabilities.has('MOVE')) throw new SafeTrashError('Gmail server does not advertise safe MOVE support');
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
          provider: 'gmail-smtp',
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
    return this.withClient(async (client) => {
      if (!client.capabilities.has('MOVE')) throw new SafeTrashError('Gmail server does not advertise safe MOVE support');
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

        let moveAccepted = false;
        try {
          const result = await client.messageMove(snapshot.uids, snapshot.trashPath, { uid: true });
          if (!result) throw new SafeTrashError('Gmail did not accept the approved move');
          moveAccepted = true;
        } catch (error) {
          if (error instanceof SafeTrashError) throw error;
          return {
            outcome: 'move-partial',
            requestedCount: snapshot.uids.length,
            verifiedMovedCount: 0,
            details: 'Gmail MOVE result was ambiguous; do not retry automatically'
          };
        }

        if (!moveAccepted) throw new SafeTrashError('Gmail did not accept the approved move');
        try {
          const remaining = await client.fetchAll(snapshot.uids, { uid: true }, { uid: true });
          const remainingSet = new Set(remaining.map((message) => message.uid));
          const verifiedMovedCount = snapshot.uids.filter((uid) => !remainingSet.has(uid)).length;
          return verifiedMovedCount === snapshot.uids.length
            ? {
                outcome: 'moved',
                requestedCount: snapshot.uids.length,
                verifiedMovedCount,
                details: `Moved ${verifiedMovedCount} message(s) to Gmail Trash`
              }
            : {
                outcome: 'move-partial',
                requestedCount: snapshot.uids.length,
                verifiedMovedCount,
                details: 'Gmail MOVE was only partially verified; do not retry automatically'
              };
        } catch {
          return {
            outcome: 'move-partial',
            requestedCount: snapshot.uids.length,
            verifiedMovedCount: 0,
            details: 'Gmail accepted MOVE but verification failed; do not retry automatically'
          };
        }
      } finally {
        lock.release();
      }
    });
  }
}
