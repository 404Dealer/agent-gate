import { lstat, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface IsolationCheckInput {
  rootDir: string;
  inboxDir: string;
}

export interface IsolationCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o7777;
const oct = (mode: number): string => `0${mode.toString(8)}`;

export async function verifyDraftDirectoryIsolation(input: IsolationCheckInput): Promise<IsolationCheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const inbox = resolve(input.inboxDir);
  const root = resolve(input.rootDir);

  try {
    const inboxStat = await lstat(inbox);
    if (inboxStat.isSymbolicLink()) {
      errors.push(`Inbox ${inbox} must not be a symlink.`);
    }
    if (!inboxStat.isDirectory()) {
      errors.push(`Inbox ${inbox} must be a directory.`);
    }
    const mode = inboxStat.mode & 0o7777;
    if (mode !== 0o1730) {
      errors.push(`Inbox ${inbox} must use dropbox permissions 1730; found ${oct(mode)}.`);
    }
  } catch (err) {
    errors.push(`Cannot stat inbox ${inbox}: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const name of ['pending', 'approved', 'sent', 'denied', 'failed']) {
    const dir = resolve(root, name);
    try {
      const entry = await lstat(dir);
      if (entry.isSymbolicLink()) {
        errors.push(`State directory ${dir} must not be a symlink.`);
      }
      if (!entry.isDirectory()) {
        errors.push(`State path ${dir} must be a directory.`);
      }
      const mode = await modeOf(dir);
      if (mode !== 0o700) {
        errors.push(`State directory ${dir} must be private mode 0700; found ${oct(mode)}.`);
      }
    } catch (err) {
      errors.push(`Cannot stat state directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const rootMode = await modeOf(root);
    if ((rootMode & 0o022) !== 0) {
      errors.push(`Draft root ${root} must not be group- or world-writable; found ${oct(rootMode)}.`);
    }
  } catch (err) {
    warnings.push(`Cannot stat draft root ${root}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function formatIsolationReport(result: IsolationCheckResult): string {
  const lines = [result.ok ? '✅ Draft directory isolation checks passed.' : '❌ Draft directory isolation checks failed.'];
  for (const error of result.errors) lines.push(`- ${error}`);
  for (const warning of result.warnings) lines.push(`- Warning: ${warning}`);
  return lines.join('\n');
}
