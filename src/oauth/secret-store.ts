import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

interface PassSecretStoreOptions {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const VALID_PASS_KEY = /^agent-gate\/[a-z0-9][a-z0-9-]*$/;

export class PassSecretStore {
  private readonly executable: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(options: PassSecretStoreOptions = {}) {
    this.env = options.env ?? process.env;
    const configuredExecutable = options.executable ?? this.env.AGENT_GATE_PASS_BIN;
    if (configuredExecutable !== undefined && !isAbsolute(configuredExecutable)) {
      throw new Error('Configured password-store executable must be absolute');
    }
    this.executable = configuredExecutable ?? 'pass';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new Error('Password-store timeout must be between 1 and 300000 milliseconds');
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (!VALID_PASS_KEY.test(key)) {
      throw new Error('Invalid agent-gate pass key');
    }
    if (!value || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
      throw new Error('Secret must be a non-empty printable single-line value');
    }

    await new Promise<void>((resolve, reject) => {
      const detached = process.platform !== 'win32';
      const child = spawn(this.executable, ['insert', '--force', '--multiline', key], {
        env: this.env,
        shell: false,
        detached,
        stdio: ['pipe', 'ignore', 'ignore']
      });
      let settled = false;
      let timer: NodeJS.Timeout;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      const terminate = (): void => {
        if (detached && child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
            return;
          } catch {
            // Fall back to killing the direct child below.
          }
        }
        child.kill('SIGKILL');
      };

      timer = setTimeout(() => {
        terminate();
        finish(new Error(`Password-store command timed out for ${key}`));
      }, this.timeoutMs);

      child.once('error', () => finish(new Error(`Could not start password-store command for ${key}`)));
      child.once('close', (code) => {
        if (code === 0) finish();
        else finish(new Error(`Password-store command failed for ${key} with exit code ${code ?? 'unknown'}`));
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(`${value}\n`);
    });
  }
}
