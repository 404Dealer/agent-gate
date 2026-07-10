import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const run = (command: string, args: string[], cwd: string) => spawnSync(command, args, {
  cwd,
  encoding: 'utf8',
  timeout: 120_000,
  env: { ...process.env, NO_COLOR: '1' }
});

test('published npm executables run from an installed tarball', { timeout: 180_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-package-test-'));
  try {
    const pack = run('npm', ['pack', '--pack-destination', dir], repoRoot);
    assert.equal(pack.status, 0, pack.stderr || pack.stdout);
    const tarballName = (await readdir(dir)).find((name) => name.endsWith('.tgz'));
    assert(tarballName, 'npm pack did not create a tarball');

    const installDir = join(dir, 'install');
    await mkdir(installDir);
    const init = run('npm', ['init', '-y'], installDir);
    assert.equal(init.status, 0, init.stderr || init.stdout);
    const install = run('npm', [
      'install', join(dir, tarballName), '--ignore-scripts', '--no-audit', '--no-fund'
    ], installDir);
    assert.equal(install.status, 0, install.stderr || install.stdout);

    for (const binary of ['agent-gate', 'agent-gate-oauth', 'agent-gate-smtp-setup']) {
      const result = run(join(installDir, 'node_modules', '.bin', binary), ['--help'], installDir);
      assert.equal(result.status, 0, `${binary}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
      assert.match(result.stdout, /Usage:/, `${binary} returned no usage text`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
