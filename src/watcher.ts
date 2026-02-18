import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { DraftSchema, type Draft } from './schema.js';

export interface DraftEvent {
  draft: Draft;
  filePath: string;
}

export interface WatcherOptions {
  rootDir: string;
  pendingDir: string;
  pollIntervalMs: number;
}

export class DraftWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;

  constructor(private readonly options: WatcherOptions) {
    super();
  }

  async ensureDirectories(): Promise<void> {
    const dirs = ['pending', 'approved', 'sent', 'denied', 'failed'].map((name) => resolve(this.options.rootDir, name));
    await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
  }

  async start(): Promise<void> {
    await this.ensureDirectories();
    this.watcher = chokidar.watch(this.options.pendingDir, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: Math.max(500, this.options.pollIntervalMs),
        pollInterval: Math.max(100, Math.floor(this.options.pollIntervalMs / 2))
      }
    });

    this.watcher.on('add', async (filePath) => {
      if (extname(filePath) !== '.json') return;
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

  private async handleNewFile(filePath: string): Promise<void> {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const draft = DraftSchema.parse(parsed);
      this.emit('draft', { draft, filePath } satisfies DraftEvent);
    } catch (error) {
      const failedPath = resolve(this.options.rootDir, 'failed', basename(filePath));
      const payload = {
        error: error instanceof Error ? error.message : String(error),
        filePath,
        failedAt: new Date().toISOString()
      };
      await mkdir(dirname(failedPath), { recursive: true });
      await rename(filePath, failedPath).catch(async () => {
        await writeFile(failedPath, JSON.stringify(payload, null, 2), 'utf8');
      });
      this.emit('malformed', { filePath, failedPath, error: payload.error });
    }
  }
}
