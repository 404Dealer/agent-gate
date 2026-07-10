import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearServiceReady,
  configuredReadyFile,
  publishServiceReady,
  SERVICE_READY_FILE
} from '../src/readiness.js';

test('production readiness path is fixed and optional outside systemd', () => {
  assert.equal(configuredReadyFile({}), undefined);
  assert.equal(configuredReadyFile({ AGENT_GATE_READY_FILE: SERVICE_READY_FILE }), SERVICE_READY_FILE);
  assert.throws(
    () => configuredReadyFile({ AGENT_GATE_READY_FILE: '/tmp/attacker-ready' }),
    /fixed production readiness path/
  );
});

test('readiness publication is exclusive, PID-bound, private, and symlink-safe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-ready-'));
  try {
    const readyPath = join(dir, 'ready');
    await publishServiceReady(readyPath, 4321);
    assert.equal(await readFile(readyPath, 'utf8'), '4321\n');
    assert.equal((await stat(readyPath)).mode & 0o777, 0o600);
    await assert.rejects(() => publishServiceReady(readyPath, 9999));

    await clearServiceReady(readyPath);
    const target = join(dir, 'target');
    await writeFile(target, 'sentinel', 'utf8');
    await symlink(target, readyPath);
    await assert.rejects(() => publishServiceReady(readyPath, 9999));
    assert.equal(await readFile(target, 'utf8'), 'sentinel');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
