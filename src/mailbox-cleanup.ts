#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promptText } from './oauth/prompts.js';
import {
  recordMailboxCleanupAudit,
  type MailboxCleanupAuditEvent
} from './mailbox/audit.js';
import { parseMailboxCleanupArgs, type MailboxCleanupOptions } from './mailbox/cli-options.js';
import { isCleanupConfirmed } from './mailbox/confirmation.js';
import { loadGmailCleanupCredentials, type GmailCleanupCredentials } from './mailbox/config.js';
import { runMailboxCleanup, type CleanupMailboxConnection, type CleanupResult } from './mailbox/cleanup.js';
import { GmailImapCleanupConnection } from './mailbox/gmail-imap.js';

export interface ManagedCleanupConnection extends CleanupMailboxConnection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface MailboxCleanupCommandDependencies {
  loadCredentials(configPath: string): Promise<GmailCleanupCredentials>;
  createConnection(credentials: GmailCleanupCredentials): ManagedCleanupConnection;
  prompt(question: string): Promise<string>;
  recordAudit(event: MailboxCleanupAuditEvent): Promise<void>;
  write(message: string): void;
}

const defaultDependencies: MailboxCleanupCommandDependencies = {
  loadCredentials: (configPath) => loadGmailCleanupCredentials(configPath),
  createConnection: (credentials) => new GmailImapCleanupConnection(credentials),
  prompt: (question) => promptText(question),
  recordAudit: (event) => recordMailboxCleanupAudit(
    process.env.AGENT_GATE_AUDIT_LOG,
    event
  ),
  write: (message) => console.log(message)
};

const countLabel = (count: number): string => count === 1 ? 'message' : 'messages';

export async function runMailboxCleanupCommand(
  options: MailboxCleanupOptions,
  dependencies: MailboxCleanupCommandDependencies = defaultDependencies
): Promise<CleanupResult> {
  const credentials = await dependencies.loadCredentials(options.configPath);
  let connection: ManagedCleanupConnection | undefined;
  try {
    connection = dependencies.createConnection(credentials);
    dependencies.write(`Gmail mailbox: ${credentials.username}`);
    await connection.connect();
    const result = await runMailboxCleanup(connection, async (preview) => {
      dependencies.write(`Unread Spam: ${preview.spam.unreadCount}`);
      dependencies.write(`Unread Trash: ${preview.trash.unreadCount}`);
      dependencies.write(`Total unread to mark read: ${preview.totalUnread}`);
      const answer = await dependencies.prompt(
        'Type MARK READ to mark exactly this unread Spam/Trash snapshot as read'
      );
      return isCleanupConfirmed(answer);
    });

    const auditEvent: MailboxCleanupAuditEvent = {
      action: 'mailbox-cleanup',
      provider: 'gmail-smtp',
      mailbox: credentials.username,
      outcome: result.outcome,
      spamUnread: result.preview.spam.unreadCount,
      trashUnread: result.preview.trash.unreadCount,
      snapshotTotal: result.preview.totalUnread,
      markedRead: result.markedRead,
      incompleteFolders: result.outcome === 'partial' ? [...result.incompleteFolders] : []
    };
    await dependencies.recordAudit(auditEvent).catch(() => {
      dependencies.write(
        'WARNING: Mailbox cleanup result could not be persisted to the audit log.'
      );
    });

    if (result.outcome === 'no-op') {
      dependencies.write('Unread Spam: 0');
      dependencies.write('Unread Trash: 0');
      dependencies.write('Nothing to change. No messages were deleted or moved.');
    } else if (result.outcome === 'cancelled') {
      dependencies.write('Cancelled. No messages were changed.');
    } else if (result.outcome === 'partial') {
      dependencies.write(
        `Marked ${result.markedRead} ${countLabel(result.markedRead)} as read. ` +
        `Cleanup was incomplete for: ${result.incompleteFolders.join(', ')}. Rerunning is safe.`
      );
    } else {
      dependencies.write(
        `Marked ${result.markedRead} ${countLabel(result.markedRead)} as read. ` +
        'No messages were deleted or moved.'
      );
    }
    return result;
  } catch {
    throw new Error('Gmail mailbox cleanup failed before completion');
  } finally {
    credentials.password = '';
    if (connection) await connection.disconnect().catch(() => undefined);
  }
}

const usage = (): string => `Usage: agent-gate-mailbox-cleanup gmail [--config PATH]

Interactively marks the previewed unread Gmail Spam and Trash UID snapshot as read.
Run only through scripts/mailbox-cleanup.sh from a human-controlled SSH/local terminal.
This command never deletes, moves, empties, or accepts credentials in arguments.`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(usage());
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Mailbox cleanup requires a human-controlled interactive TTY');
  }
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) {
    throw new Error('Mailbox cleanup must run as the isolated agentgate user, never as root');
  }
  await runMailboxCleanupCommand(parseMailboxCleanupArgs(args));
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown mailbox cleanup failure';
    console.error(`Mailbox cleanup failed: ${message}`);
    process.exitCode = 1;
  });
}
