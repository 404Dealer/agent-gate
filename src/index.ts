#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { loadConfig, type AgentGateConfig } from './config.js';
import { DraftWatcher } from './watcher.js';
import { AgentGateBot } from './bot.js';
import { Executor } from './executor.js';
import { formatIsolationReport, verifyDraftDirectoryIsolation } from './security.js';
import {
  clearServiceReady,
  configuredReadyFile,
  publishServiceReady
} from './readiness.js';
import { GmailInboxBroker, credentialsFromConfig } from './mailbox-broker/gmail-inbox.js';
import { MailboxBrokerServer } from './mailbox-broker/server.js';
import { MAILBOX_SOCKET_PATH } from './mailbox-broker/protocol.js';

const configuredMailboxBroker = (config: AgentGateConfig): MailboxBrokerServer | null => {
  const socketPath = process.env.AGENT_GATE_MAILBOX_SOCKET;
  if (socketPath === undefined) return null;
  if (socketPath !== MAILBOX_SOCKET_PATH) throw new Error('Mailbox broker socket path is not fixed');
  const gidRaw = process.env.AGENT_GATE_MAILBOX_GID;
  if (!gidRaw || !/^[1-9][0-9]*$/.test(gidRaw)) throw new Error('Mailbox broker group is not configured');
  const credentials = credentialsFromConfig(config);
  if (!credentials) throw new Error('Mailbox broker requires the eligible gmail-smtp provider');
  return new MailboxBrokerServer(new GmailInboxBroker(credentials), socketPath, Number(gidRaw));
};

async function main(): Promise<void> {
  const readyFile = configuredReadyFile();
  await clearServiceReady(readyFile);
  const config = await loadConfig();
  const inboxDir = resolve(config.watch.directory);
  const draftsRoot = dirname(inboxDir);

  if (config.security.enforceProductionPermissions) {
    const report = await verifyDraftDirectoryIsolation({ rootDir: draftsRoot, inboxDir });
    if (!report.ok) {
      console.error(formatIsolationReport(report));
      process.exit(78);
    }
    console.log(formatIsolationReport(report));
  }

  const watcher = new DraftWatcher({
    rootDir: draftsRoot,
    inboxDir,
    pollIntervalMs: config.watch.pollIntervalMs
  });

  const executor = new Executor(config, draftsRoot);
  const bot = new AgentGateBot(config, watcher, executor, draftsRoot);

  await watcher.start();
  console.log('[agent-gate] watcher started, watching', config.watch.directory);

  await bot.start();
  console.log('[agent-gate] bot handlers registered');

  const mailboxBroker = configuredMailboxBroker(config);
  if (mailboxBroker) {
    await mailboxBroker.start();
    console.log('[agent-gate] mailbox broker listening');
  }

  bot.poll().catch(async (err) => {
    console.error('[agent-gate] bot polling error:', err);
    await clearServiceReady(readyFile).catch(() => undefined);
    await mailboxBroker?.stop().catch(() => undefined);
    process.exit(1);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[agent-gate] received ${signal}, shutting down...`);
    await clearServiceReady(readyFile).catch(() => undefined);
    await mailboxBroker?.stop().catch(() => undefined);
    await bot.stop();
    await watcher.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await publishServiceReady(readyFile);
  console.log('[agent-gate] ready ✓');
}

if (process.argv.slice(2).includes('--help')) {
  console.log('Usage: agent-gate\n\nStarts the agent-gate approval service using AGENT_GATE_CONFIG or ./config.yaml.');
} else {
  main().catch((error) => {
    console.error('[agent-gate] fatal:', error);
    process.exit(1);
  });
}
