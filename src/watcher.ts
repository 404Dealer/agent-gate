import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { DraftSchema, updateStatus, type Draft } from './schema.js';

const MAX_DRAFT_SIZE_BYTES = 512 * 1024;

interface FileIdentity {
  dev: number;
  ino: number;
}

async function writePrivateExclusive(path: string, content: string): Promise<void> {
  const target = await open(path, 'wx', 0o600);
  try {
    await target.writeFile(content, 'utf8');
    await target.sync();
  } catch (error) {
    await target.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
  // Once write + fsync succeed, the private file is committed even if close
  // reports a late error. Do not create a contradictory failed state.
  await target.close().catch(() => {});
}

async function unlinkIfSameEntry(path: string, expected: FileIdentity): Promise<void> {
  const current = await lstat(path).catch(() => null);
  if (current?.dev === expected.dev && current.ino === expected.ino) {
    await unlink(path);
  }
}

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
      console.log(`[nightdrop] new draft detected: ${basename(filePath)}`);
      await this.handleNewFile(filePath);
    });

    this.watcher.on('error', (error) => {
      if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      }
    });

    await new Promise<void>((resolveReady, rejectReady) => {
      const onReady = (): void => {
        this.watcher?.off('error', onStartupError);
        resolveReady();
      };
      const onStartupError = (error: unknown): void => {
        this.watcher?.off('ready', onReady);
        rejectReady(error);
      };
      this.watcher!.once('ready', onReady);
      this.watcher!.once('error', onStartupError);
    });
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }

  async replayPending(): Promise<void> {
    await this.ensureDirectories();
    const entries = (await readdir(this.pendingDir, { withFileTypes: true }))
      .filter((entry) => extname(entry.name) === '.json' && !entry.name.startsWith('.'))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const pendingPath = resolve(this.pendingDir, entry.name);
      try {
        const metadata = await lstat(pendingPath);
        if (!entry.isFile() || !metadata.isFile()) throw new Error('Invalid pending draft file type');
        if (metadata.size > MAX_DRAFT_SIZE_BYTES) throw new Error('Pending draft file is too large');
        const draft = DraftSchema.parse(JSON.parse(await readFile(pendingPath, 'utf8')));
        this.emit('draft', { draft, filePath: pendingPath } satisfies DraftEvent);
      } catch (error) {
        const failedPath = resolve(this.options.rootDir, 'failed', entry.name);
        await rename(pendingPath, failedPath).catch(() => {});
        this.emit('malformed', {
          filePath: pendingPath,
          failedPath,
          error: error instanceof Error ? error.message : 'Invalid pending draft'
        });
      }
    }
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
    let sourceIdentity: FileIdentity | null = null;
    let pendingCommitted = false;

    try {
      const entry = await lstat(inboxPath);
      sourceIdentity = { dev: entry.dev, ino: entry.ino };
      if (!entry.isFile()) {
        throw new Error('Invalid draft file type: only regular files are allowed');
      }
      if (entry.size > MAX_DRAFT_SIZE_BYTES) {
        throw new Error(`Draft file too large: ${entry.size} bytes (max ${MAX_DRAFT_SIZE_BYTES})`);
      }

      const source = await open(inboxPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw: string;
      try {
        const opened = await source.stat();
        if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) {
          throw new Error('Draft changed before it could be claimed');
        }
        if (opened.size > MAX_DRAFT_SIZE_BYTES) {
          throw new Error(`Draft file too large: ${opened.size} bytes (max ${MAX_DRAFT_SIZE_BYTES})`);
        }
        const capture = Buffer.allocUnsafe(MAX_DRAFT_SIZE_BYTES + 1);
        let captured = 0;
        while (captured < capture.length) {
          const { bytesRead } = await source.read(capture, captured, capture.length - captured, null);
          if (bytesRead === 0) break;
          captured += bytesRead;
        }
        if (captured > MAX_DRAFT_SIZE_BYTES) {
          throw new Error(`Draft file too large: captured content exceeds ${MAX_DRAFT_SIZE_BYTES} bytes`);
        }
        raw = capture.subarray(0, captured).toString('utf8');
      } finally {
        await source.close();
      }
      const parsed = JSON.parse(raw);
      const draft = DraftSchema.parse(parsed);
      await writePrivateExclusive(pendingPath, raw);
      pendingCommitted = true;
      await unlinkIfSameEntry(inboxPath, sourceIdentity).catch(() => {
        // eslint-disable-next-line no-console
        console.warn(`[nightdrop] claimed ${basename(inboxPath)} but could not remove the unchanged inbox entry`);
      });
      this.emit('draft', { draft, filePath: pendingPath } satisfies DraftEvent);
    } catch (error) {
      if (pendingCommitted) {
        // eslint-disable-next-line no-console
        console.error(`[nightdrop] pending draft committed but post-claim handling failed for ${basename(inboxPath)}`);
        return;
      }
      const failedPath = resolve(this.options.rootDir, 'failed', basename(inboxPath));
      const payload = {
        error: error instanceof Error ? error.message : String(error),
        filePath: pendingPath,
        failedAt: new Date().toISOString()
      };
      await mkdir(dirname(failedPath), { recursive: true });
      try {
        await writePrivateExclusive(failedPath, JSON.stringify(payload, null, 2));
      } catch {
        // Preserve the inbox source when failure evidence cannot be persisted.
        // eslint-disable-next-line no-console
        console.error(`[nightdrop] could not persist failure evidence for ${basename(inboxPath)}`);
        return;
      }
      if (sourceIdentity) await unlinkIfSameEntry(inboxPath, sourceIdentity).catch(() => {});
      this.emit('malformed', { filePath: inboxPath, failedPath, error: payload.error });
    }
  }
}
