#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promptLiteral } from './oauth/prompts.js';
import {
  recordMailboxCleanupAudit,
  type MailboxCleanupAuditEvent
} from './mailbox/audit.js';
import { parseMailboxCleanupArgs, type MailboxCleanupOptions } from './mailbox/cli-options.js';
import { isCleanupConfirmed } from './mailbox/confirmation.js';
import { loadGmailCleanupCredentials, type GmailCleanupCredentials } from './mailbox/config.js';
import {
  applyMailboxCleanup,
  prepareMailboxCleanup,
  type CleanupMailboxConnection,
  type CleanupResult,
  type MailboxCleanupPlan
} from './mailbox/cleanup.js';
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
  prompt: (question) => promptLiteral(question),
  recordAudit: (event) => recordMailboxCleanupAudit(
    process.env.NIGHTDROP_AUDIT_LOG,
    event
  ),
  write: (message) => console.log(message)
};

const countLabel = (count: number): string => count === 1 ? 'message' : 'messages';

const safeWrite = (dependencies: MailboxCleanupCommandDependencies, message: string): void => {
  try {
    dependencies.write(message);
  } catch {
    // A completed remote action must never be reclassified because local output failed.
  }
};

const getPreviewPlan = async (
  credentials: GmailCleanupCredentials,
  dependencies: MailboxCleanupCommandDependencies
): Promise<MailboxCleanupPlan> => {
  const connection = dependencies.createConnection(credentials);
  let plan: MailboxCleanupPlan | undefined;
  let failed = false;
  try {
    await connection.connect();
    plan = await prepareMailboxCleanup(connection);
  } catch {
    failed = true;
  } finally {
    try {
      await connection.disconnect();
    } catch {
      failed = true;
    }
  }
  if (failed || !plan) throw new Error('preview failed');
  return plan;
};

const applyWithFreshConnection = async (
  credentials: GmailCleanupCredentials,
  plan: MailboxCleanupPlan,
  dependencies: MailboxCleanupCommandDependencies
): Promise<CleanupResult> => {
  const connection = dependencies.createConnection(credentials);
  let result: CleanupResult | undefined;
  let failedBeforeResult = false;
  try {
    await connection.connect();
    result = await applyMailboxCleanup(connection, plan);
  } catch {
    failedBeforeResult = true;
  } finally {
    try {
      await connection.disconnect();
    } catch {
      if (!result) failedBeforeResult = true;
    }
  }
  if (failedBeforeResult || !result) throw new Error('apply failed');
  return result;
};

const persistAndReport = async (
  result: CleanupResult,
  dependencies: MailboxCleanupCommandDependencies
): Promise<void> => {
  const auditEvent: MailboxCleanupAuditEvent = {
    action: 'mailbox-cleanup',
    provider: 'gmail-smtp',
    outcome: result.outcome,
    snapshotTotal: result.preview.totalUnread,
    verifiedRead: result.verifiedRead,
    incompleteFolders: result.outcome === 'partial' ? [...result.incompleteFolders] : []
  };

  try {
    await dependencies.recordAudit(auditEvent);
  } catch {
    safeWrite(dependencies, 'WARNING: Mailbox cleanup result could not be persisted to the audit log.');
  }

  if (result.outcome === 'no-op') {
    safeWrite(dependencies, 'Nothing to change. No messages were deleted or moved.');
  } else if (result.outcome === 'cancelled') {
    safeWrite(dependencies, 'Cancelled. No messages were changed.');
  } else if (result.outcome === 'partial') {
    safeWrite(
      dependencies,
      `Verified ${result.verifiedRead} ${countLabel(result.verifiedRead)} are read. ` +
      `Cleanup was incomplete for: ${result.incompleteFolders.join(', ')}. Rerunning is safe.`
    );
  } else {
    safeWrite(
      dependencies,
      `Verified ${result.verifiedRead} ${countLabel(result.verifiedRead)} are read. ` +
      'No messages were deleted or moved.'
    );
  }
};

export async function runMailboxCleanupCommand(
  options: MailboxCleanupOptions,
  dependencies: MailboxCleanupCommandDependencies = defaultDependencies
): Promise<CleanupResult> {
  const credentials = await dependencies.loadCredentials(options.configPath);
  let result: CleanupResult;
  try {
    dependencies.write(`Gmail mailbox: ${credentials.username}`);
    const plan = await getPreviewPlan(credentials, dependencies);
    dependencies.write(`Unread Spam: ${plan.preview.spam.unreadCount}`);
    dependencies.write(`Unread Trash: ${plan.preview.trash.unreadCount}`);
    dependencies.write(`Total unread to mark read: ${plan.preview.totalUnread}`);

    if (plan.preview.totalUnread === 0) {
      result = { outcome: 'no-op', preview: plan.preview, verifiedRead: 0 };
    } else {
      const answer = await dependencies.prompt(
        'Type MARK READ to mark exactly this unread Spam/Trash snapshot as read'
      );
      if (!isCleanupConfirmed(answer)) {
        result = { outcome: 'cancelled', preview: plan.preview, verifiedRead: 0 };
      } else {
        result = await applyWithFreshConnection(credentials, plan, dependencies);
      }
    }
  } catch {
    credentials.password = '';
    throw new Error('Gmail mailbox cleanup failed before completion');
  }

  credentials.password = '';
  await persistAndReport(result, dependencies);
  return result;
}

const usage = (): string => `Usage: nightdrop-mailbox-cleanup gmail [--config PATH]

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
    throw new Error('Mailbox cleanup must run as the isolated nightdrop user, never as root');
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
