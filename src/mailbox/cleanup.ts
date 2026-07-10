export type CleanupTarget = 'spam' | 'trash';

export interface MailboxDescriptor {
  path: string;
  /** Raw flags from the server's LIST response. Derived specialUse values are intentionally excluded. */
  flags: readonly string[];
}

export interface MailboxUidSnapshot {
  uidValidity: string;
  uids: number[];
}

export interface CleanupMailboxConnection {
  listMailboxes(): Promise<readonly MailboxDescriptor[]>;
  snapshotUnread(path: string): Promise<MailboxUidSnapshot>;
  markSeen(
    target: CleanupTarget,
    path: string,
    expectedUidValidity: string,
    uids: readonly number[]
  ): Promise<number>;
}

export interface CleanupPreview {
  spam: { unreadCount: number };
  trash: { unreadCount: number };
  totalUnread: number;
}

export type CleanupResult =
  | { outcome: 'no-op' | 'cancelled'; preview: CleanupPreview; verifiedRead: 0 }
  | { outcome: 'applied'; preview: CleanupPreview; verifiedRead: number }
  | {
      outcome: 'partial';
      preview: CleanupPreview;
      verifiedRead: number;
      incompleteFolders: CleanupTarget[];
    };

interface PlannedFolder {
  target: CleanupTarget;
  path: string;
  uidValidity: string;
  uids: number[];
}

export interface MailboxCleanupPlan {
  preview: CleanupPreview;
  folders: readonly PlannedFolder[];
}

const SPECIAL_USE: Record<CleanupTarget, string> = {
  spam: '\\Junk',
  trash: '\\Trash'
};

const hasRawFlag = (mailbox: MailboxDescriptor, expected: string): boolean =>
  mailbox.flags.some((flag) => flag.toLowerCase() === expected.toLowerCase());

export const selectAuthoritativeMailbox = (
  mailboxes: readonly MailboxDescriptor[],
  target: CleanupTarget
): MailboxDescriptor => {
  const matches = mailboxes.filter((mailbox) => hasRawFlag(mailbox, SPECIAL_USE[target]));
  if (matches.length !== 1) {
    throw new Error(`Gmail ${target} special-use mailbox is missing or ambiguous`);
  }
  return matches[0];
};

const normalizeSnapshot = (snapshot: MailboxUidSnapshot): MailboxUidSnapshot => {
  if (!/^[1-9]\d*$/.test(snapshot.uidValidity)) {
    throw new Error('Gmail returned an invalid mailbox identity');
  }
  const unique = new Set<number>();
  for (const uid of snapshot.uids) {
    if (!Number.isSafeInteger(uid) || uid < 1) {
      throw new Error('Gmail returned an invalid message identifier');
    }
    unique.add(uid);
  }
  return { uidValidity: snapshot.uidValidity, uids: [...unique].sort((a, b) => a - b) };
};

export async function prepareMailboxCleanup(
  connection: CleanupMailboxConnection
): Promise<MailboxCleanupPlan> {
  const mailboxes = await connection.listMailboxes();
  const folders: PlannedFolder[] = [];

  for (const target of ['spam', 'trash'] as const) {
    const mailbox = selectAuthoritativeMailbox(mailboxes, target);
    const snapshot = normalizeSnapshot(await connection.snapshotUnread(mailbox.path));
    folders.push({ target, path: mailbox.path, ...snapshot });
  }

  return {
    preview: {
      spam: { unreadCount: folders[0].uids.length },
      trash: { unreadCount: folders[1].uids.length },
      totalUnread: folders[0].uids.length + folders[1].uids.length
    },
    folders
  };
}

export async function applyMailboxCleanup(
  connection: CleanupMailboxConnection,
  plan: MailboxCleanupPlan
): Promise<CleanupResult> {
  let verifiedRead = 0;
  const incompleteFolders: CleanupTarget[] = [];

  for (const folder of plan.folders) {
    if (folder.uids.length === 0) continue;
    try {
      const current = selectAuthoritativeMailbox(await connection.listMailboxes(), folder.target);
      if (current.path !== folder.path) {
        incompleteFolders.push(folder.target);
        continue;
      }
      const verified = await connection.markSeen(
        folder.target,
        folder.path,
        folder.uidValidity,
        folder.uids
      );
      if (!Number.isSafeInteger(verified) || verified < 0 || verified > folder.uids.length) {
        incompleteFolders.push(folder.target);
        continue;
      }
      verifiedRead += verified;
      if (verified !== folder.uids.length) incompleteFolders.push(folder.target);
    } catch {
      incompleteFolders.push(folder.target);
    }
  }

  if (incompleteFolders.length > 0) {
    return { outcome: 'partial', preview: plan.preview, verifiedRead, incompleteFolders };
  }
  return { outcome: 'applied', preview: plan.preview, verifiedRead };
}

export async function runMailboxCleanup(
  connection: CleanupMailboxConnection,
  confirm: (preview: CleanupPreview) => Promise<boolean>
): Promise<CleanupResult> {
  const plan = await prepareMailboxCleanup(connection);
  if (plan.preview.totalUnread === 0) {
    return { outcome: 'no-op', preview: plan.preview, verifiedRead: 0 };
  }
  if (!await confirm(plan.preview)) {
    return { outcome: 'cancelled', preview: plan.preview, verifiedRead: 0 };
  }
  return applyMailboxCleanup(connection, plan);
}
