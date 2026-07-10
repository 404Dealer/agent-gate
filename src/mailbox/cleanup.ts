export interface MailboxDescriptor {
  path: string;
  specialUse?: string;
}

export interface MailboxUidSnapshot {
  uidValidity: string;
  uids: number[];
}

export interface CleanupMailboxConnection {
  listMailboxes(): Promise<readonly MailboxDescriptor[]>;
  snapshotUnread(path: string): Promise<MailboxUidSnapshot>;
  markSeen(path: string, expectedUidValidity: string, uids: readonly number[]): Promise<number>;
}

export interface CleanupPreview {
  spam: { unreadCount: number };
  trash: { unreadCount: number };
  totalUnread: number;
}

export type CleanupResult =
  | { outcome: 'no-op' | 'cancelled'; preview: CleanupPreview; markedRead: 0 }
  | { outcome: 'applied'; preview: CleanupPreview; markedRead: number }
  | {
      outcome: 'partial';
      preview: CleanupPreview;
      markedRead: number;
      incompleteFolders: CleanupTarget[];
    };

type CleanupTarget = 'spam' | 'trash';

interface PlannedFolder {
  target: CleanupTarget;
  path: string;
  uidValidity: string;
  uids: number[];
}

const SPECIAL_USE: Record<CleanupTarget, string> = {
  spam: '\\Junk',
  trash: '\\Trash'
};

const selectMailbox = (
  mailboxes: readonly MailboxDescriptor[],
  target: CleanupTarget
): MailboxDescriptor => {
  const matches = mailboxes.filter((mailbox) => mailbox.specialUse === SPECIAL_USE[target]);
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

export async function runMailboxCleanup(
  connection: CleanupMailboxConnection,
  confirm: (preview: CleanupPreview) => Promise<boolean>
): Promise<CleanupResult> {
  const mailboxes = await connection.listMailboxes();
  const plans: PlannedFolder[] = [];

  for (const target of ['spam', 'trash'] as const) {
    const mailbox = selectMailbox(mailboxes, target);
    const snapshot = normalizeSnapshot(await connection.snapshotUnread(mailbox.path));
    plans.push({ target, path: mailbox.path, ...snapshot });
  }

  const preview: CleanupPreview = {
    spam: { unreadCount: plans[0].uids.length },
    trash: { unreadCount: plans[1].uids.length },
    totalUnread: plans[0].uids.length + plans[1].uids.length
  };

  if (preview.totalUnread === 0) {
    return { outcome: 'no-op', preview, markedRead: 0 };
  }
  if (!await confirm(preview)) {
    return { outcome: 'cancelled', preview, markedRead: 0 };
  }

  let markedRead = 0;
  const incompleteFolders: CleanupTarget[] = [];
  for (const plan of plans) {
    if (plan.uids.length === 0) continue;
    try {
      const marked = await connection.markSeen(plan.path, plan.uidValidity, plan.uids);
      if (!Number.isSafeInteger(marked) || marked < 0 || marked > plan.uids.length) {
        incompleteFolders.push(plan.target);
        continue;
      }
      markedRead += marked;
      if (marked !== plan.uids.length) incompleteFolders.push(plan.target);
    } catch {
      incompleteFolders.push(plan.target);
    }
  }
  if (incompleteFolders.length > 0) {
    return { outcome: 'partial', preview, markedRead, incompleteFolders };
  }
  return { outcome: 'applied', preview, markedRead };
}
