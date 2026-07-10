import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export interface MailboxCleanupAuditEvent {
  action: 'mailbox-cleanup';
  provider: 'gmail-smtp';
  outcome: 'no-op' | 'cancelled' | 'applied' | 'partial';
  snapshotTotal: number;
  verifiedRead: number;
  incompleteFolders: Array<'spam' | 'trash'>;
}

export async function recordMailboxCleanupAudit(
  path: string | undefined,
  event: MailboxCleanupAuditEvent
): Promise<void> {
  if (!path || !isAbsolute(path)) {
    throw new Error('Mailbox cleanup audit path must be an absolute installed path');
  }

  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    const uid = process.getuid?.();
    if (!stats.isFile() || uid === undefined || stats.uid !== uid || (stats.mode & 0o022) !== 0) {
      throw new Error('unsafe audit file');
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    await handle.writeFile(`${line}\n`, 'utf8');
  } catch {
    throw new Error('Mailbox cleanup audit persistence failed');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
