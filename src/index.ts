#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { loadConfig, type NightdropConfig } from './config.js';
import { DraftWatcher } from './watcher.js';
import { NightdropBot } from './bot.js';
import { Executor } from './executor.js';
import { formatIsolationReport, verifyDraftDirectoryIsolation } from './security.js';
import {
  clearServiceReady,
  configuredReadyFile,
  publishServiceReady
} from './readiness.js';
import { GmailInboxBroker } from './mailbox-broker/gmail-inbox.js';
import { MailboxBrokerServer } from './mailbox-broker/server.js';
import { submitTrashProposal } from './mailbox-broker/trash-proposal.js';
import { submitUnsubscribeProposal } from './mailbox-broker/unsubscribe-proposal.js';
import { GmailUnsubscribeService } from './mailbox-broker/gmail-unsubscribe.js';
import { MAILBOX_SOCKET_PATH } from './mailbox-broker/protocol.js';
import { mailboxProfilesFromConfig } from './mailbox-broker/profiles.js';
import type { MailboxAdapter } from './mailbox-broker/adapter.js';
import { OutlookMailboxAdapter } from './mailbox-broker/outlook-mailbox.js';
import { getSharedOutlookTokenClient } from './providers/outlook-token-client.js';

const configuredMailboxBroker = (config: NightdropConfig): MailboxBrokerServer | null => {
  const socketPath = process.env.NIGHTDROP_MAILBOX_SOCKET;
  if (socketPath === undefined) return null;
  if (socketPath !== MAILBOX_SOCKET_PATH) throw new Error('Mailbox broker socket path is not fixed');
  const gidRaw = process.env.NIGHTDROP_MAILBOX_GID;
  if (!gidRaw || !/^[1-9][0-9]*$/.test(gidRaw)) throw new Error('Mailbox broker group is not configured');
  const profiles = mailboxProfilesFromConfig(config);
  if (profiles.size === 0) return null;
  const adapters = new Map<string, MailboxAdapter>();
  const prepareUnsubscribe = new Map<string, (ref: string) => Promise<unknown>>();
  for (const profile of profiles.values()) {
    if (profile.backend === 'gmail') {
      adapters.set(profile.name, new GmailInboxBroker(
        profile.credentials,
        profile.name,
        profile.providerName,
        profile.address
      ));
      const unsubscribe = new GmailUnsubscribeService(
        profile.credentials,
        profile.name,
        profile.providerName,
        profile.address
      );
      prepareUnsubscribe.set(profile.name, (ref) => unsubscribe.prepareReference(ref));
    } else {
      const adapter = new OutlookMailboxAdapter(
        profile.name,
        profile.providerName,
        profile.providerConfig,
        getSharedOutlookTokenClient(profile.providerConfig)
      );
      adapters.set(profile.name, adapter);
      prepareUnsubscribe.set(profile.name, (ref) => adapter.prepareUnsubscribeReference(ref));
    }
  }
  return new MailboxBrokerServer(
    adapters,
    socketPath,
    Number(gidRaw),
    (profileName, refs, context) => {
      const profile = profiles.get(profileName);
      if (!profile) throw new Error('Mailbox profile is not configured');
      return submitTrashProposal(config.watch.directory, refs, context, profile.providerName);
    },
    async (profileName, ref, context) => {
      const profile = profiles.get(profileName);
      const prepare = prepareUnsubscribe.get(profileName);
      if (!profile || !prepare) throw new Error('Mailbox profile is not configured');
      await prepare(ref);
      return submitUnsubscribeProposal(config.watch.directory, ref, context, profile.providerName);
    }
  );
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
  const bot = new NightdropBot(config, watcher, executor, draftsRoot);

  await bot.start();
  console.log('[nightdrop] bot handlers registered');

  await watcher.replayPending();
  await watcher.start();
  console.log('[nightdrop] watcher ready, watching', config.watch.directory);

  const mailboxBroker = configuredMailboxBroker(config);
  if (mailboxBroker) {
    await mailboxBroker.start();
    console.log('[nightdrop] mailbox broker listening');
  }

  bot.poll().catch(async (err) => {
    console.error('[nightdrop] bot polling error:', err);
    await clearServiceReady(readyFile).catch(() => undefined);
    await mailboxBroker?.stop().catch(() => undefined);
    process.exit(1);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[nightdrop] received ${signal}, shutting down...`);
    await clearServiceReady(readyFile).catch(() => undefined);
    await mailboxBroker?.stop().catch(() => undefined);
    await bot.stop();
    await watcher.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await publishServiceReady(readyFile);
  console.log('[nightdrop] ready ✓');
}

if (process.argv.slice(2).includes('--help')) {
  console.log('Usage: nightdrop\n\nStarts the Nightdrop approval service using NIGHTDROP_CONFIG or ./config.yaml.');
} else {
  main().catch((error) => {
    console.error('[nightdrop] fatal:', error);
    process.exit(1);
  });
}
