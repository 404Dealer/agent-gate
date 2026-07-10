#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { DraftWatcher } from './watcher.js';
import { AgentGateBot } from './bot.js';
import { Executor } from './executor.js';
import { formatIsolationReport, verifyDraftDirectoryIsolation } from './security.js';

async function main(): Promise<void> {
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

  bot.poll().catch((err) => {
    console.error('[agent-gate] bot polling error:', err);
    process.exit(1);
  });

  console.log('[agent-gate] ready ✓');

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[agent-gate] received ${signal}, shutting down...`);
    await bot.stop();
    await watcher.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (process.argv.slice(2).includes('--help')) {
  console.log('Usage: agent-gate\n\nStarts the agent-gate approval service using AGENT_GATE_CONFIG or ./config.yaml.');
} else {
  main().catch((error) => {
    console.error('[agent-gate] fatal:', error);
    process.exit(1);
  });
}
