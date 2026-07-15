import { rm, writeFile } from 'node:fs/promises';

export const SERVICE_READY_FILE = '/run/nightdrop/ready';

export function configuredReadyFile(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = environment.NIGHTDROP_READY_FILE;
  if (path === undefined) return undefined;
  if (path !== SERVICE_READY_FILE) {
    throw new Error('NIGHTDROP_READY_FILE is not the fixed production readiness path');
  }
  return path;
}

export async function clearServiceReady(path: string | undefined): Promise<void> {
  if (!path) return;
  await rm(path, { force: true });
}

export async function publishServiceReady(
  path: string | undefined,
  pid: number = process.pid
): Promise<void> {
  if (!path) return;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid service PID');
  await writeFile(path, `${pid}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}
