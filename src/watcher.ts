import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { DraftSchema, updateStatus, type Draft } from './schema.js';

const MAX_DRAFT_SIZE_BYTES = 512 * 1024;

export interface DraftEvent {
  draft: Draft;
  filePath: string;
}

export interface WatcherOptions {
  rootDir: string;
  inboxDir: string;
  pollIntervalMs: number;
}

export class DraftWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;

  constructor(private readonly options: WatcherOptions) {
    super();
  }

  private get pendingDir(): string {
    return resolve(this.options.rootDir, 'pending');
  }

  async ensureDirectories(): Promise<void> {
    const dirs = ['pending', 'approved', 'sent', 'denied', 'failed'].map((name) => resolve(this.options.rootDir, name));
    await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
  }

  async start(): Promise<void> {
    await this.ensureDirectories();
    this.watcher = chokidar.watch(this.options.inboxDir, {
      persistent: true,
      ignoreInitial: false,
      usePolling: true,
      interval: this.options.pollIntervalMs,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 200
      }
    });

    this.watcher.on('add', async (filePath) => {
      if (extname(filePath) !== '.json') return;
      if (basename(filePath).startsWith('.')) return;
      // eslint-disable-next-line no-console
      console.log(`[agent-gate] new draft detected: ${basename(filePath)}`);
      await this.handleNewFile(filePath);
    });

    this.watcher.on('error', (error) => {
      this.emit('error', error);
    });
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }

  async failPending(filePath: string, error: string): Promise<void> {
    const pendingPath = resolve(this.pendingDir, basename(filePath));
    const failedPath = resolve(this.options.rootDir, 'failed', basename(filePath));
    const raw = await readFile(pendingPath, 'utf8');
    const draft = DraftSchema.parse(JSON.parse(raw));
    const failed = updateStatus(draft, 'failed', {
      approval: { ...draft.approval, error: error.slice(0, 500) }
    });
    await writeFile(pendingPath, JSON.stringify(failed, null, 2), 'utf8');
    await rename(pendingPath, failedPath);
  }

  private async handleNewFile(inboxPath: string): Promise<void> {
    const pendingPath = resolve(this.pendingDir, basename(inboxPath));

    try {
      const entry = await lstat(inboxPath);
      if (!entry.isFile()) {
        throw new Error('Invalid draft file type: only regular files are allowed');
      }
      if (entry.size > MAX_DRAFT_SIZE_BYTES) {
        throw new Error(`Draft file too large: ${entry.size} bytes (max ${MAX_DRAFT_SIZE_BYTES})`);
      }

      await rename(inboxPath, pendingPath);

      const raw = await readFile(pendingPath, 'utf8');
      const parsed = JSON.parse(raw);
      const draft = DraftSchema.parse(parsed);
      this.emit('draft', { draft, filePath: pendingPath } satisfies DraftEvent);
    } catch (error) {
      const failedPath = resolve(this.options.rootDir, 'failed', basename(inboxPath));
      const payload = {
        error: error instanceof Error ? error.message : String(error),
        filePath: pendingPath,
        failedAt: new Date().toISOString()
      };
      await mkdir(dirname(failedPath), { recursive: true });
      await rename(pendingPath, failedPath)
        .catch(async () => rename(inboxPath, failedPath))
        .catch(async () => {
          await writeFile(failedPath, JSON.stringify(payload, null, 2), 'utf8');
        });
      this.emit('malformed', { filePath: pendingPath, failedPath, error: payload.error });
    }
  }
}
