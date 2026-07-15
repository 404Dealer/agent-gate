import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const legacyHyphenated = ['agent', 'gate'].join('-');
const legacyCompact = ['agent', 'gate'].join('');
const legacyUnderscored = ['agent', 'gate'].join('_');
const forbidden = [legacyHyphenated, legacyCompact, legacyUnderscored];
const ignoredTopLevel = new Set(['.git', 'node_modules', 'dist']);

const containsForbiddenIdentity = (value: string): boolean => {
  const normalized = value.toLowerCase();
  return forbidden.some((identity) => normalized.includes(identity));
};

const scanTree = async (directory: string): Promise<string[]> => {
  const findings: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const repoPath = relative(repoRoot, path);
    const topLevel = repoPath.split('/')[0];
    if (ignoredTopLevel.has(topLevel)) continue;
    if (containsForbiddenIdentity(repoPath)) findings.push(`${repoPath}: filename`);
    if (entry.isDirectory()) {
      findings.push(...await scanTree(path));
      continue;
    }
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      if (containsForbiddenIdentity(target)) findings.push(`${repoPath}: symlink target`);
      continue;
    }
    if (!entry.isFile()) continue;
    const contents = await readFile(path);
    if (contents.includes(0)) continue;
    if (containsForbiddenIdentity(contents.toString('utf8'))) findings.push(`${repoPath}: contents`);
  }
  return findings;
};

test('active repository identity is Nightdrop-only', async () => {
  assert.deepEqual(await scanTree(repoRoot), []);
});

test('package publishes only Nightdrop executables', async () => {
  const packageDocument = JSON.parse(
    await readFile(join(repoRoot, 'package.json'), 'utf8')
  ) as { name?: string; bin?: Record<string, string> };
  assert.equal(packageDocument.name, 'nightdrop');
  assert.deepEqual(packageDocument.bin, {
    nightdrop: './dist/index.js',
    'nightdrop-oauth': './scripts/oauth-setup.sh',
    'nightdrop-smtp-setup': './scripts/smtp-setup.sh',
    'nightdrop-mailbox-cleanup': './scripts/mailbox-cleanup.sh',
    'nightdrop-mailbox': './dist/mailbox-client.js'
  });
});

test('operator guidance documents the versioned credential keys onboarding creates', async () => {
  const [oauthGuide, handoffGuide, exampleConfig] = await Promise.all([
    readFile(join(repoRoot, 'docs/oauth-onboarding.md'), 'utf8'),
    readFile(join(repoRoot, 'docs/credential-handoff.md'), 'utf8'),
    readFile(join(repoRoot, 'config.example.yaml'), 'utf8')
  ]);
  const unversionedGeneratedKey = /^nightdrop\/(?:google-(?:client-id|refresh-token)|microsoft-(?:client-id|refresh-token)|zoho-(?:client-id|client-secret|refresh-token))$/m;
  for (const guide of [oauthGuide, handoffGuide]) {
    assert.doesNotMatch(guide, unversionedGeneratedKey);
  }
  for (const key of ['google-client-id', 'google-refresh-token', 'microsoft-client-id', 'microsoft-refresh-token']) {
    assert.match(oauthGuide, new RegExp(`^nightdrop/${key}-<transaction>$`, 'm'));
  }
  for (const key of [
    'google-client-id',
    'google-refresh-token',
    'microsoft-client-id',
    'microsoft-refresh-token',
    'zoho-client-id',
    'zoho-client-secret',
    'zoho-refresh-token'
  ]) {
    assert.match(handoffGuide, new RegExp(`^nightdrop/${key}-<transaction>$`, 'm'));
  }
  assert.match(exampleConfig, /refreshTokenKey: "nightdrop\/microsoft-refresh-token-<transaction>"/);
});
