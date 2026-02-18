import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { DraftWatcher } from './watcher.js';
import { AgentGateBot } from './bot.js';
import { Executor } from './executor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main(): Promise<void> {
  const config = await loadConfig();
  const pendingDir = resolve(config.watch.directory);
  const draftsRoot = resolve(pendingDir, '..');

  const watcher = new DraftWatcher({
    rootDir: draftsRoot,
    pendingDir,
    pollIntervalMs: config.watch.pollIntervalMs
  });

  const executor = new Executor(config, draftsRoot);
  const bot = new AgentGateBot(config, watcher, executor, draftsRoot);

  await watcher.start();
  // eslint-disable-next-line no-console
  console.log('[agent-gate] watcher started, watching', config.watch.directory);

  // Register handlers (sync setup)
  await bot.start();
  // eslint-disable-next-line no-console
  console.log('[agent-gate] bot handlers registered');

  // Start long-poll in background (grammy's poll() blocks until stopped)
  bot.poll().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[agent-gate] bot polling error:', err);
    process.exit(1);
  });

  // eslint-disable-next-line no-console
  console.log('[agent-gate] ready ✓');

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[agent-gate] received ${signal}, shutting down...`);
    await bot.stop();
    await watcher.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[agent-gate] fatal:', error);
  process.exit(1);
});
