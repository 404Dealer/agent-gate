import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPkceChallenge } from '../src/oauth/pkce.js';
import { createOAuthCallbackListener } from '../src/oauth/callback.js';
import { PassSecretStore } from '../src/oauth/secret-store.js';
import { updateProviderConfig, validateProviderConfigTarget } from '../src/oauth/config-writer.js';
import { buildGmailAuthorizationUrl, exchangeGmailAuthorizationCode, fetchGmailIdentity } from '../src/oauth/gmail.js';
import { buildOutlookAuthorizationUrl, exchangeOutlookAuthorizationCode, requestOutlookDeviceCode, pollOutlookDeviceToken, fetchOutlookIdentity } from '../src/oauth/outlook.js';
import { persistGmailOnboarding, persistOutlookOnboarding, persistZohoOnboarding } from '../src/oauth/persist.js';
import { parseOAuthSetupArgs } from '../src/oauth/cli-options.js';
import { buildZohoAuthorizationUrl, exchangeZohoAuthorizationCode, fetchZohoSenderChoices, getZohoRegionEndpoints, validateZohoCallbackRegion } from '../src/oauth/zoho.js';
import { parseSelection, sanitizeTerminalText } from '../src/oauth/selection.js';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const assertVersionedCredentialKeys = (keys: string[], bases: string[]): string => {
  assert.equal(keys.length, bases.length);
  const suffixes = bases.map((base) => {
    const key = keys.find((candidate) => candidate.startsWith(`nightdrop/${base}-`));
    assert(key, `missing versioned key for ${base}`);
    const match = key.match(new RegExp(`^nightdrop/${base}-([a-f0-9]{24})$`));
    assert(match, `invalid versioned key for ${base}`);
    return match[1];
  });
  assert.equal(new Set(suffixes).size, 1);
  return suffixes[0];
};

test('PKCE challenge matches the RFC 7636 S256 example', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(createPkceChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('OAuth setup CLI accepts only non-secret options and makes device code Outlook-only', () => {
  assert.deepEqual(parseOAuthSetupArgs(['gmail', '--config', '/opt/nightdrop/config/config.yaml', '--port', '8765']), {
    provider: 'gmail',
    configPath: '/opt/nightdrop/config/config.yaml',
    port: 8765,
    deviceCode: false
  });
  assert.deepEqual(parseOAuthSetupArgs(['outlook', '--device-code']), {
    provider: 'outlook',
    configPath: '/opt/nightdrop/config/config.yaml',
    port: 8765,
    deviceCode: true
  });
  assert.deepEqual(parseOAuthSetupArgs(['outlook', '--profile', 'work']), {
    provider: 'outlook',
    configPath: '/opt/nightdrop/config/config.yaml',
    port: 8765,
    deviceCode: false,
    profile: 'work'
  });
  assert.throws(() => parseOAuthSetupArgs(['gmail', '--profile', 'personal']), /only valid for outlook/);
  assert.throws(
    () => parseOAuthSetupArgs(['gmail', '--client-secret', 'must-not-enter-argv']),
    /Unknown option/
  );
  assert.throws(() => parseOAuthSetupArgs(['zoho', '--device-code']), /only valid for outlook/);
});

test('OAuth errors never reflect remote HTTP reason phrases', async () => {
  for (const relativePath of ['../src/oauth/gmail.ts', '../src/oauth/outlook.ts', '../src/oauth/zoho.ts']) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /response\.statusText/);
  }
});

test('production installer validates canonical safe arguments without side effects', () => {
  const installerPath = fileURLToPath(new URL('../scripts/install-production.sh', import.meta.url));
  const validate = (functionName: string, value: string): number | null => spawnSync(
    '/bin/bash',
    ['-c', 'source "$1"; "$2" "$3"', 'installer-validation', installerPath, functionName, value],
    { encoding: 'utf8' }
  ).status;

  assert.equal(validate('validate_install_dir', '/opt/nightdrop'), 0);
  for (const unsafePath of ['/', '/opt', '/tmp/nightdrop', '/opt/../etc', '/opt//nightdrop', '/opt/nightdrop\nInjected=true']) {
    assert.notEqual(validate('validate_install_dir', unsafePath), 0, unsafePath);
  }

  assert.equal(validate('validate_telegram_user_id', '2061243435'), 0);
  for (const unsafeId of ['0', '-1', '1\nallowedUsers: [2]', '9007199254740992']) {
    assert.notEqual(validate('validate_telegram_user_id', unsafeId), 0, unsafeId);
  }

  assert.equal(validate('validate_agent_user', 'spacex'), 0);
  for (const unsafeUser of ['root;id', '--help', 'UpperCase', 'space user']) {
    assert.notEqual(validate('validate_agent_user', unsafeUser), 0, unsafeUser);
  }

  const validateAgentIdentity = (name: string, uid: string, duplicateUid = false): number | null => spawnSync(
    '/bin/bash',
    [
      '-c',
      [
        'source "$1"',
        'MOCK_NAME="$2"',
        'MOCK_UID="$3"',
        'MOCK_DUPLICATE="$4"',
        'id() { if [[ "$1" == "-u" ]]; then printf "%s\\n" "$MOCK_UID"; else return 0; fi; }',
        'getent() { [[ "$1" == "passwd" ]] || return 1; printf "%s:x:%s:1000::/home/%s:/bin/bash\\n" "$MOCK_NAME" "$MOCK_UID" "$MOCK_NAME"; if [[ "$MOCK_DUPLICATE" == "true" ]]; then printf "alias:x:%s:1001::/home/alias:/bin/bash\\n" "$MOCK_UID"; fi; }',
        'if validate_agent_identity "$MOCK_NAME"; then exit 0; else exit 1; fi'
      ].join('; '),
      'installer-agent-identity',
      installerPath,
      name,
      uid,
      String(duplicateUid)
    ],
    { encoding: 'utf8' }
  ).status;
  assert.equal(validateAgentIdentity('hermes', '1000'), 0);
  assert.notEqual(validateAgentIdentity('administrator', '0'), 0);
  assert.notEqual(validateAgentIdentity('hermes', '1000', true), 0);

  const validateAgentSnapshot = (snapshotUid: string, currentUid: string): number | null => spawnSync('/bin/bash', [
    '-c',
    [
      'source "$1"',
      'AGENT_USER=hermes',
      'AGENT_UID_SNAPSHOT="$2"',
      'CURRENT_UID="$3"',
      'id() { printf "%s\\n" "$CURRENT_UID"; }',
      'getent() { [[ "$1" == "passwd" ]] || return 1; printf "hermes:x:%s:1000::/home/hermes:/bin/bash\\n" "$CURRENT_UID"; }',
      'if validate_agent_identity_snapshot; then exit 0; else exit 1; fi'
    ].join('; '),
    'installer-agent-snapshot',
    installerPath,
    snapshotUid,
    currentUid
  ], { encoding: 'utf8' }).status;
  assert.equal(validateAgentSnapshot('1000', '1000'), 0);
  assert.notEqual(validateAgentSnapshot('1000', '1001'), 0);
});

test('production installer rejects unmanaged service identity and capability-group collisions', async () => {
  const installerPath = fileURLToPath(new URL('../scripts/install-production.sh', import.meta.url));
  const validate = (functionName: string, values: string[]): number | null => spawnSync(
    '/bin/bash',
    [
      '-c',
      'source "$1"; shift; function_name="$1"; shift; if "$function_name" "$@"; then exit 0; else exit 1; fi',
      'installer-identity-validation',
      installerPath,
      functionName,
      ...values
    ],
    { encoding: 'utf8' }
  ).status;

  const lockedService = 'nightdrop:x:499:497::/home/nightdrop:/usr/sbin/nologin';
  const primaryGroup = 'nightdrop:x:497:';
  assert.equal(validate('validate_service_identity_record', [
    lockedService, 'nightdrop L 2026-07-14 0 99999 7 -1', primaryGroup, '1000', '1000'
  ]), 0);
  for (const [record, status, group] of [
    ['nightdrop:x:1000:497::/home/nightdrop:/usr/sbin/nologin', 'nightdrop L 2026-07-14 0 99999 7 -1', primaryGroup],
    ['nightdrop:x:499:497::/srv/nightdrop:/usr/sbin/nologin', 'nightdrop L 2026-07-14 0 99999 7 -1', primaryGroup],
    ['nightdrop:x:499:497::/home/nightdrop:/bin/bash', 'nightdrop L 2026-07-14 0 99999 7 -1', primaryGroup],
    [lockedService, 'nightdrop P 2026-07-14 0 99999 7 -1', primaryGroup],
    [lockedService, 'nightdrop L 2026-07-14 0 99999 7 -1', 'nightdrop:x:42:'],
    [lockedService, 'nightdrop L 2026-07-14 0 99999 7 -1', 'nightdrop:x:497:unexpected']
  ]) {
    assert.notEqual(validate('validate_service_identity_record', [record, status, group, '1000', '1000']), 0);
  }

  assert.equal(validate('validate_capability_group_record', [
    'nightdrop-mailbox:x:498:nightdrop,hermes', 'nightdrop-mailbox', 'nightdrop', 'hermes', '1000'
  ]), 0);
  for (const record of [
    'nightdrop-mailbox:x:1000:nightdrop,hermes',
    'nightdrop-mailbox:x:498:hermes',
    'nightdrop-mailbox:x:498:nightdrop,hermes,unexpected',
    'different-group:x:498:nightdrop,hermes'
  ]) {
    assert.notEqual(validate('validate_capability_group_record', [
      record, 'nightdrop-mailbox', 'nightdrop', 'hermes', '1000'
    ]), 0);
  }

  const passwdGraph = [
    lockedService,
    'hermes:x:1000:1000::/home/hermes:/bin/bash'
  ].join('\n');
  const groupGraph = [
    primaryGroup,
    'nightdrop-inbox:x:496:nightdrop,hermes',
    'nightdrop-mailbox:x:495:nightdrop,hermes',
    'hermes:x:1000:'
  ].join('\n');
  const graphArgs = [
    passwdGraph, groupGraph, 'nightdrop', 'nightdrop-inbox', 'nightdrop-mailbox',
    '499', '497', '496', '495'
  ];
  assert.equal(validate('validate_numeric_identity_graph', graphArgs), 0);
  for (const [passwdRecords, groupRecords] of [
    [`${passwdGraph}\nalias:x:499:1100::/nonexistent:/usr/sbin/nologin`, groupGraph],
    [`${passwdGraph}\nnightdrop:x:1101:1101::/nonexistent:/usr/sbin/nologin`, groupGraph],
    [`${passwdGraph}\nother:x:1100:497::/home/other:/bin/bash`, groupGraph],
    [`${passwdGraph}\nother:x:1100:496::/home/other:/bin/bash`, groupGraph],
    [passwdGraph, `${groupGraph}\nalias:x:496:`],
    [passwdGraph, `${groupGraph}\nnightdrop-inbox:x:1102:`]
  ]) {
    assert.notEqual(validate('validate_numeric_identity_graph', [
      passwdRecords, groupRecords, ...graphArgs.slice(2)
    ]), 0);
  }

  assert.equal(validate('validate_effective_group_graph', [
    'nightdrop nightdrop-inbox nightdrop-mailbox',
    'hermes nightdrop-inbox nightdrop-mailbox',
    'nightdrop', 'nightdrop-inbox', 'nightdrop-mailbox', 'hermes', 'strict'
  ]), 0);
  assert.notEqual(validate('validate_effective_group_graph', [
    'nightdrop nightdrop-inbox nightdrop-mailbox',
    'operators nightdrop-inbox nightdrop-mailbox',
    'nightdrop', 'nightdrop-inbox', 'nightdrop-mailbox', 'operators', 'strict', 'hermes'
  ]), 0);
  for (const [serviceGroups, agentGroups] of [
    ['nightdrop nightdrop-inbox nightdrop-mailbox docker', 'hermes nightdrop-inbox nightdrop-mailbox'],
    ['nightdrop nightdrop-inbox nightdrop-mailbox', 'hermes docker nightdrop-inbox nightdrop-mailbox'],
    ['nightdrop nightdrop-inbox nightdrop-mailbox', 'hermes lxd nightdrop-inbox nightdrop-mailbox'],
    ['nightdrop nightdrop-inbox nightdrop-mailbox', 'hermes sudo nightdrop-inbox nightdrop-mailbox'],
    ['nightdrop nightdrop-inbox', 'hermes nightdrop-inbox nightdrop-mailbox'],
    ['nightdrop nightdrop-inbox nightdrop-mailbox', 'hermes nightdrop nightdrop-inbox nightdrop-mailbox'],
    ['nightdrop nightdrop-inbox nightdrop-mailbox', 'hermes nightdrop-inbox']
  ]) {
    assert.notEqual(validate('validate_effective_group_graph', [
      serviceGroups, agentGroups, 'nightdrop', 'nightdrop-inbox', 'nightdrop-mailbox', 'hermes', 'strict'
    ]), 0);
  }

  assert.equal(validate('validate_agent_primary_group_for_profile', ['operators', 'hermes', 'standard']), 0);
  assert.equal(validate('validate_agent_primary_group_for_profile', ['hermes', 'hermes', 'strict']), 0);
  assert.notEqual(validate('validate_agent_primary_group_for_profile', ['operators', 'hermes', 'strict']), 0);

  assert.equal(validate('validate_agent_group_boundary', [
    'operators sudo docker nightdrop-inbox nightdrop-mailbox',
    'operators', 'hermes', 'nightdrop-inbox', 'nightdrop-mailbox', 'true', 'standard'
  ]), 0);
  assert.notEqual(validate('validate_agent_group_boundary', [
    'operators sudo docker nightdrop-inbox nightdrop-mailbox',
    'operators', 'hermes', 'nightdrop-inbox', 'nightdrop-mailbox', 'true', 'strict'
  ]), 0);
  assert.notEqual(validate('validate_agent_group_boundary', [
    'operators nightdrop nightdrop-inbox nightdrop-mailbox',
    'operators', 'hermes', 'nightdrop-inbox', 'nightdrop-mailbox', 'true', 'standard'
  ]), 0);
  assert.equal(validate('validate_agent_group_boundary', [
    'hermes nightdrop-inbox nightdrop-mailbox',
    'hermes', 'hermes', 'nightdrop-inbox', 'nightdrop-mailbox', 'false', 'strict'
  ]), 0);
  assert.equal(validate('validate_agent_group_boundary', [
    'operators sudo docker nightdrop-inbox nightdrop-mailbox',
    'operators', 'hermes', 'nightdrop-inbox', 'nightdrop-mailbox', 'false', 'standard'
  ]), 0);
  assert.notEqual(validate('validate_agent_group_boundary', [
    'operators sudo nightdrop-inbox',
    'operators', 'hermes', 'nightdrop-inbox', 'nightdrop-mailbox', 'false', 'standard'
  ]), 0);
  assert.equal(validate('validate_effective_group_graph', [
    'nightdrop nightdrop-inbox nightdrop-mailbox',
    'operators sudo docker nightdrop-inbox nightdrop-mailbox',
    'nightdrop', 'nightdrop-inbox', 'nightdrop-mailbox', 'operators', 'standard'
  ]), 0);

  assert.equal(validate('validate_deployment_profile', ['standard']), 0);
  assert.equal(validate('validate_deployment_profile', ['strict']), 0);
  assert.notEqual(validate('validate_deployment_profile', ['isolated']), 0);
  assert.notEqual(validate('validate_deployment_profile', ['']), 0);

  assert.notEqual(validate('direct_agent_host_admin_present', ['false', 'false', 'false']), 0);
  assert.equal(validate('direct_agent_host_admin_present', ['true', 'false', 'false']), 0);
  assert.equal(validate('direct_agent_host_admin_present', ['false', 'true', 'false']), 0);
  assert.equal(validate('direct_agent_host_admin_present', ['false', 'false', 'true']), 0);
  assert.notEqual(validate('direct_agent_host_admin_present', ['maybe', 'false', 'false']), 0);

  assert.equal(validate('validate_privileged_agent_acknowledgment', ['standard', 'false', 'false']), 0);
  assert.notEqual(validate('validate_privileged_agent_acknowledgment', ['standard', 'true', 'false']), 0);
  assert.equal(validate('validate_privileged_agent_acknowledgment', ['standard', 'true', 'true']), 0);
  assert.notEqual(validate('validate_privileged_agent_acknowledgment', ['strict', 'false', 'true']), 0);
  assert.notEqual(validate('validate_privileged_agent_acknowledgment', ['strict', 'true', 'true']), 0);

  assert.equal(validate('validate_agent_access_probe_results', [
    'true', 'true', 'false', 'false', 'false', 'false', 'false', 'false', 'false', 'false', 'false'
  ]), 0);
  assert.equal(validate('validate_agent_access_probe_results', [
    'true', 'true', 'false', 'false', 'false', 'false', 'false', 'false', 'true', 'false', 'true'
  ]), 0);
  for (const results of [
    ['false', 'true', 'false', 'false', 'false', 'false', 'false', 'false', 'false', 'false', 'false'],
    ['true', 'true', 'true', 'false', 'false', 'false', 'false', 'false', 'false', 'false', 'false'],
    ['true', 'true', 'false', 'true', 'false', 'false', 'false', 'false', 'false', 'false', 'false'],
    ['true', 'true', 'false', 'false', 'true', 'false', 'false', 'false', 'false', 'false', 'false'],
    ['true', 'true', 'false', 'false', 'false', 'false', 'false', 'false', 'true', 'false', 'false'],
    ['true', 'true', 'false', 'false', 'false', 'false', 'false', 'false', 'false', 'true', 'false']
  ]) {
    assert.notEqual(validate('validate_agent_access_probe_results', results), 0);
  }

  assert.equal(validate('validate_service_home_parent_record', ['root', 'root', '755']), 0);
  for (const record of [
    ['root', 'root', '700'],
    ['root', 'root', '775'],
    ['root', 'users', '755'],
    ['operator', 'root', '755']
  ]) {
    assert.notEqual(validate('validate_service_home_parent_record', record), 0);
  }
  assert.equal(validate('validate_root_owned_directory_record', ['root', 'root', '755']), 0);
  for (const record of [
    ['root', 'root', '775'],
    ['root', 'root', '700'],
    ['root', 'root', '644'],
    ['root', 'users', '755'],
    ['operator', 'root', '755']
  ]) {
    assert.notEqual(validate('validate_root_owned_directory_record', record), 0);
  }
  assert.equal(validate('validate_root_owned_directory_chain', ['/usr/nightdrop-review-missing/path']), 0);
  assert.notEqual(validate('validate_root_owned_directory_chain', ['/tmp/nightdrop-review-missing/path']), 0);

  const validateAuditAcl = (
    grant: boolean,
    toolsAvailable: boolean,
    setfaclStatus: number,
    getfaclStatus: number,
    aclOutput: string
  ): number | null => spawnSync('/bin/bash', [
    '-c',
    [
      'source "$1"',
      'SETFACL_STATUS="$4"',
      'GETFACL_STATUS="$5"',
      'ACL_OUTPUT="$6"',
      'setfacl() { return "$SETFACL_STATUS"; }',
      'getfacl() { printf "%b" "$ACL_OUTPUT"; return "$GETFACL_STATUS"; }',
      'if [[ "$3" == "true" ]]; then SETFACL_BIN=setfacl; GETFACL_BIN=getfacl; else SETFACL_BIN=""; GETFACL_BIN=""; fi',
      'if configure_agent_audit_acl /tmp/audit "$2" hermes "$SETFACL_BIN" "$GETFACL_BIN"; then exit 0; else exit 1; fi'
    ].join('; '),
    'installer-audit-acl',
    installerPath,
    String(grant),
    String(toolsAvailable),
    String(setfaclStatus),
    String(getfaclStatus),
    aclOutput
  ], { encoding: 'utf8' }).status;
  assert.notEqual(validateAuditAcl(false, false, 0, 0, ''), 0);
  assert.notEqual(validateAuditAcl(false, true, 1, 0, 'user:hermes:r--\n'), 0);
  assert.notEqual(validateAuditAcl(false, true, 0, 1, ''), 0);
  assert.equal(validateAuditAcl(false, true, 1, 0, 'user::rw-\n'), 0);
  assert.equal(validateAuditAcl(true, true, 0, 0, 'user:hermes:r--\n'), 0);

  const collisionRoot = await mkdtemp(join(tmpdir(), 'nightdrop-identity-collision-'));
  const mutationLog = join(collisionRoot, 'mutations');
  try {
    const managedMutationLog = join(collisionRoot, 'managed-mutations');
    const managedUpgrade = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'validate_agent_identity_snapshot() { return 0; }',
        'MUTATION_LOG="$2"',
        'id() { return 0; }',
        'getent() { return 0; }',
        'validate_managed_identity_marker() { return 0; }',
        'validate_managed_identity_records() { return 0; }',
        'useradd() { printf "useradd\\n" >> "$MUTATION_LOG"; }',
        'groupadd() { printf "groupadd\\n" >> "$MUTATION_LOG"; }',
        'usermod() { printf "usermod\\n" >> "$MUTATION_LOG"; }',
        'prepare_nightdrop_identities'
      ].join('; '),
      'installer-managed-upgrade',
      installerPath,
      managedMutationLog
    ], { encoding: 'utf8' });
    assert.equal(managedUpgrade.status, 0, managedUpgrade.stderr || managedUpgrade.stdout);
    await assert.rejects(readFile(managedMutationLog), { code: 'ENOENT' });

    const nssFailureMutationLog = join(collisionRoot, 'nss-failure-mutations');
    const nssFailure = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'validate_agent_identity_snapshot() { return 0; }',
        'SERVICE_HOME="$2/nss-home"',
        'IDENTITY_MARKER_DIR="$2/nss-marker"',
        'IDENTITY_MARKER="$IDENTITY_MARKER_DIR/managed-identities-v1"',
        'MUTATION_LOG="$3"',
        'getent() { return 3; }',
        'validate_service_home_parent() { return 0; }',
        'validate_managed_identity_records() { return 0; }',
        'validate_managed_identity_marker() { return 0; }',
        'groupadd() { printf "groupadd\\n" >> "$MUTATION_LOG"; }',
        'useradd() { printf "useradd\\n" >> "$MUTATION_LOG"; }',
        'usermod() { printf "usermod\\n" >> "$MUTATION_LOG"; }',
        'chown() { printf "chown\\n" >> "$MUTATION_LOG"; }',
        'chmod() { printf "chmod\\n" >> "$MUTATION_LOG"; }',
        'install() { printf "install\\n" >> "$MUTATION_LOG"; }',
        'if prepare_nightdrop_identities; then exit 90; fi',
        '[[ ! -e "$MUTATION_LOG" ]]'
      ].join('; '),
      'installer-nss-failure',
      installerPath,
      collisionRoot,
      nssFailureMutationLog
    ], { encoding: 'utf8' });
    assert.equal(nssFailure.status, 0, nssFailure.stderr || nssFailure.stdout);

    const builderCleanupLog = join(collisionRoot, 'builder-cleanup');
    const unrelatedBuilderCleanup = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'validate_agent_identity_snapshot() { return 0; }',
        'BUILD_USER=nightdrop-build-unrelated',
        'BUILD_USER_CREATED=false',
        'BUILD_HOME=""',
        'BUILD_ROOT=""',
        'MAILBOX_CLI_TEMP=""',
        'CLEANUP_LOG="$2"',
        'id() { return 0; }',
        'pkill() { printf "pkill\\n" >> "$CLEANUP_LOG"; }',
        'userdel() { printf "userdel\\n" >> "$CLEANUP_LOG"; }',
        'cleanup_builder',
        '[[ ! -e "$CLEANUP_LOG" ]]'
      ].join('; '),
      'installer-builder-cleanup',
      installerPath,
      builderCleanupLog
    ], { encoding: 'utf8' });
    assert.equal(unrelatedBuilderCleanup.status, 0, unrelatedBuilderCleanup.stderr || unrelatedBuilderCleanup.stdout);

    const ownedBuilderCleanup = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'validate_agent_identity_snapshot() { return 0; }',
        'BUILD_USER=nightdrop-build-owned',
        'BUILD_GROUP=nightdrop-build-owned',
        'BUILD_USER_CREATED=true',
        'BUILD_GROUP_CREATED=true',
        'BUILD_IDENTITY_OWNERSHIP_UNCERTAIN=false',
        'BUILD_UID=12345',
        'BUILD_GID=12346',
        'BUILD_USER_PRESENT=true',
        'BUILD_GROUP_PRESENT=true',
        'BUILD_HOME=/tmp/nightdrop-build-owned-home',
        'BUILD_ROOT=""',
        'MAILBOX_CLI_TEMP=""',
        'CLEANUP_LOG="$2"',
        'nss_entry_state() { if [[ "$1" == "passwd" ]]; then [[ "$BUILD_USER_PRESENT" == true ]] && printf "present\\n" || printf "absent\\n"; else [[ "$BUILD_GROUP_PRESENT" == true ]] && printf "present\\n" || printf "absent\\n"; fi; }',
        'getent() { if [[ "$1" == group ]]; then printf "nightdrop-build-owned:x:12346:\\n"; elif [[ "$BUILD_USER_PRESENT" == true ]]; then printf "nightdrop-build-owned:x:12345:12346::/tmp/nightdrop-build-owned-home:/usr/sbin/nologin\\n"; elif [[ $# -eq 1 ]]; then printf "root:x:0:0:root:/root:/bin/bash\\n"; else return 2; fi; }',
        'id() { case "$1" in -u) printf "12345\\n" ;; -gn|-Gn) printf "nightdrop-build-owned\\n" ;; *) return 1 ;; esac; }',
        'pkill() { printf "pkill\\n" >> "$CLEANUP_LOG"; }',
        'userdel() { printf "userdel\\n" >> "$CLEANUP_LOG"; BUILD_USER_PRESENT=false; }',
        'groupdel() { printf "groupdel\\n" >> "$CLEANUP_LOG"; BUILD_GROUP_PRESENT=false; }',
        'cleanup_builder'
      ].join('; '),
      'installer-owned-builder-cleanup',
      installerPath,
      builderCleanupLog
    ], { encoding: 'utf8' });
    assert.equal(ownedBuilderCleanup.status, 0, ownedBuilderCleanup.stderr || ownedBuilderCleanup.stdout);
    assert.equal(await readFile(builderCleanupLog, 'utf8'), 'pkill\nuserdel\ngroupdel\n');

    const failedBuilderCleanupLog = join(collisionRoot, 'builder-cleanup-failed');
    const failedBuilderCleanup = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'BUILD_USER=nightdrop-build-owned',
        'BUILD_GROUP=nightdrop-build-owned',
        'BUILD_USER_CREATED=true',
        'BUILD_GROUP_CREATED=true',
        'BUILD_IDENTITY_OWNERSHIP_UNCERTAIN=false',
        'BUILD_UID=12345',
        'BUILD_GID=12346',
        'CLEANUP_LOG="$2"',
        'nss_entry_state() { return 3; }',

        'pkill() { printf "pkill\\n" >> "$CLEANUP_LOG"; }',
        'userdel() { printf "userdel\\n" >> "$CLEANUP_LOG"; return 1; }',
        'groupdel() { printf "groupdel\\n" >> "$CLEANUP_LOG"; return 1; }',
        'if cleanup_builder_identity; then exit 90; fi',
        '[[ "$BUILD_USER_CREATED" == true && "$BUILD_GROUP_CREATED" == true ]]'
      ].join('; '),
      'installer-failed-builder-cleanup',
      installerPath,
      failedBuilderCleanupLog
    ], { encoding: 'utf8' });
    assert.equal(failedBuilderCleanup.status, 0, failedBuilderCleanup.stderr || failedBuilderCleanup.stdout);
    await assert.rejects(stat(failedBuilderCleanupLog), { code: 'ENOENT' });

    const unsafeManagedParent = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'validate_agent_identity_snapshot() { return 0; }',
        'AGENT_USER=hermes',
        'login_definition_limit() { printf "1000\\n"; }',
        'getent() { if [[ "$1" == "passwd" ]]; then printf "nightdrop:x:499:497::/home/nightdrop:/usr/sbin/nologin\\n"; else printf "nightdrop:x:497:\\n"; fi; }',
        'passwd() { printf "nightdrop L 2026-07-14 0 99999 7 -1\\n"; }',
        'id() { if [[ "$1" == "-gn" ]]; then printf "hermes\\n"; else printf "nightdrop nightdrop-inbox nightdrop-mailbox\\n"; fi; }',
        'validate_agent_identity() { return 0; }',
        'validate_service_identity_record() { return 0; }',
        'validate_capability_group_record() { return 0; }',
        'validate_numeric_identity_graph() { return 0; }',
        'validate_effective_group_graph() { return 0; }',
        'validate_private_directory() { return 0; }',
        'validate_service_home_parent() { return 1; }',
        'if validate_managed_identity_records; then exit 0; else exit 1; fi'
      ].join('; '),
      'installer-unsafe-managed-parent',
      installerPath
    ], { encoding: 'utf8' });
    assert.notEqual(unsafeManagedParent.status, 0);

    const freshMutationLog = join(collisionRoot, 'fresh-mutations');
    const freshHome = join(collisionRoot, 'fresh-home');
    const freshInstall = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'validate_agent_identity_snapshot() { return 0; }',
        'SERVICE_HOME="$2/fresh-home"',
        'IDENTITY_MARKER_DIR="$2/fresh-marker"',
        'IDENTITY_MARKER="$IDENTITY_MARKER_DIR/managed-identities-v1"',
        'MUTATION_LOG="$3"',
        'id() { return 1; }',
        'getent() { if [[ $# -eq 1 ]]; then return 0; fi; return 2; }',
        'validate_service_home_parent() { return 0; }',
        'validate_managed_identity_records() { return 0; }',
        'validate_managed_identity_marker() { return 0; }',
        'groupadd() { printf "groupadd %s\\n" "$*" >> "$MUTATION_LOG"; }',
        'useradd() { printf "useradd %s\\n" "$*" >> "$MUTATION_LOG"; }',
        'usermod() { printf "usermod %s\\n" "$*" >> "$MUTATION_LOG"; }',
        'chown() { printf "chown %s\\n" "$*" >> "$MUTATION_LOG"; }',
        'chmod() { printf "chmod %s\\n" "$*" >> "$MUTATION_LOG"; }',
        'install() { local target="${@: -1}"; if [[ "$1" == "-d" ]]; then /usr/bin/mkdir -p "$target"; else : > "$target"; fi; printf "install %s\\n" "$*" >> "$MUTATION_LOG"; }',
        'prepare_nightdrop_identities'
      ].join('; '),
      'installer-fresh-identities',
      installerPath,
      collisionRoot,
      freshMutationLog
    ], { encoding: 'utf8' });
    assert.equal(freshInstall.status, 0, freshInstall.stderr || freshInstall.stdout);
    const freshMutations = await readFile(freshMutationLog, 'utf8');
    const primaryGroupCreation = freshMutations.indexOf('groupadd --system nightdrop\n');
    const serviceCreation = freshMutations.indexOf(`useradd -r -m -d ${freshHome} -g nightdrop -s /usr/sbin/nologin nightdrop\n`);
    const inboxCreation = freshMutations.indexOf('groupadd --system nightdrop-inbox\n');
    assert(primaryGroupCreation >= 0);
    assert(serviceCreation > primaryGroupCreation);
    assert(inboxCreation > serviceCreation);

    for (const failurePoint of [
      'groupadd:1', 'useradd:1', 'chown:1', 'chmod:1', 'groupadd:2', 'groupadd:3',
      'usermod:1', 'usermod:2', 'identity-validation', 'install:1', 'install:2',
      'marker-write', 'marker-validation'
    ]) {
      const failureRoot = join(collisionRoot, `failure-${failurePoint.replace(':', '-')}`);
      const conditionalFailure = spawnSync('/bin/bash', [
        '-c',
        [
          'source "$1"',
        'validate_agent_identity_snapshot() { return 0; }',
          'FAIL_AT="$2"',
          'TEST_ROOT="$3"',
          'STATE_ROOT="$TEST_ROOT/state"',
          '/usr/bin/mkdir -p "$STATE_ROOT"',
          'SERVICE_HOME="$TEST_ROOT/home"',
          'IDENTITY_MARKER_DIR="$TEST_ROOT/marker"',
          'IDENTITY_MARKER="$IDENTITY_MARKER_DIR/managed-identities-v1"',
          'declare -A CALL_COUNTS=()',
          'step() { local name="$1" count; count=$(( ${CALL_COUNTS[$name]:-0} + 1 )); CALL_COUNTS[$name]="$count"; [[ "$name:$count" != "$FAIL_AT" ]]; }',
          'getent() { local kind="$1" name="${2:-}"; [[ -n "$name" ]] || return 0; if [[ "$kind" == "passwd" && "$name" == "nightdrop" && -f "$STATE_ROOT/user" ]]; then printf "nightdrop:x:499:497::%s:/usr/sbin/nologin\\n" "$SERVICE_HOME"; return 0; fi; if [[ "$kind" == "group" && -f "$STATE_ROOT/group-$name" ]]; then printf "%s:x:497:\\n" "$name"; return 0; fi; return 2; }',
          'validate_service_home_parent() { return 0; }',
          'validate_managed_identity_records() { [[ "$FAIL_AT" != "identity-validation" ]]; }',
          'validate_managed_identity_marker() { [[ "$FAIL_AT" != "marker-validation" ]]; }',
          'groupadd() { local name="${@: -1}"; : > "$STATE_ROOT/group-$name"; step groupadd; }',
          'useradd() { : > "$STATE_ROOT/user"; /usr/bin/mkdir -p "$SERVICE_HOME"; step useradd; }',
          'usermod() { local groups="$2" user="$3" group; for group in ${groups//,/ }; do : > "$STATE_ROOT/member-$user-$group"; done; step usermod; }',
          'chown() { step chown; }',
          'chmod() { step chmod; }',
          'userdel() { /usr/bin/rm -f "$STATE_ROOT/user" "$STATE_ROOT"/member-nightdrop-*; /usr/bin/rm -rf -- "$SERVICE_HOME"; }',
          'groupdel() { /usr/bin/rm -f "$STATE_ROOT/group-$1" "$STATE_ROOT"/member-*"-$1"; }',
          'install() { local target="${@: -1}"; if [[ "$1" == "-d" ]]; then /usr/bin/mkdir -p "$target"; elif [[ "$FAIL_AT" == "marker-write" ]]; then /usr/bin/mkdir -p "$target"; else : > "$target"; fi; step install; }',
          'if prepare_nightdrop_identities; then exit 80; fi',
          '[[ ! -e "$STATE_ROOT/user" && ! -e "$SERVICE_HOME" && ! -L "$SERVICE_HOME" ]] || exit 81',
          '[[ ! -e "$STATE_ROOT/group-nightdrop" && ! -e "$STATE_ROOT/group-nightdrop-inbox" && ! -e "$STATE_ROOT/group-nightdrop-mailbox" ]] || exit 82',
          'compgen -G "$STATE_ROOT/member-*" >/dev/null && exit 83',
          '[[ ! -e "$IDENTITY_MARKER_DIR" && ! -L "$IDENTITY_MARKER_DIR" ]] || exit 84',
          'exit 0'
        ].join('; '),
        'installer-conditional-failure',
        installerPath,
        failurePoint,
        failureRoot
      ], { encoding: 'utf8' });
      assert.equal(conditionalFailure.status, 0, conditionalFailure.stderr || `residual state at ${failurePoint}`);
    }

    const privateDirectory = join(collisionRoot, 'private-home');
    const privateDirectoryLink = join(collisionRoot, 'private-home-link');
    await mkdir(privateDirectory);
    await chmod(privateDirectory, 0o700);
    await symlink(privateDirectory, privateDirectoryLink);
    const localUser = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
    const localGroup = spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(validate('validate_private_directory', [
      privateDirectory, localUser, localGroup, '700'
    ]), 0);
    assert.notEqual(validate('validate_private_directory', [
      privateDirectoryLink, localUser, localGroup, '700'
    ]), 0);
    await chmod(privateDirectory, 0o750);
    assert.notEqual(validate('validate_private_directory', [
      privateDirectory, localUser, localGroup, '700'
    ]), 0);

    const hostileHome = join(collisionRoot, 'existing-home');
    await mkdir(hostileHome);
    const freshCollision = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'validate_agent_identity_snapshot() { return 0; }',
        'IDENTITY_MARKER_DIR="$2/marker"',
        'IDENTITY_MARKER="$IDENTITY_MARKER_DIR/managed-identities-v1"',
        'SERVICE_HOME="$2/existing-home"',
        'MUTATION_LOG="$3"',
        'id() { return 1; }',
        'getent() { if [[ $# -eq 1 ]]; then return 0; fi; return 2; }',
        'groupadd() { printf "groupadd\\n" >> "$MUTATION_LOG"; }',
        'useradd() { printf "useradd\\n" >> "$MUTATION_LOG"; }',
        'usermod() { printf "usermod\\n" >> "$MUTATION_LOG"; }',
        'prepare_nightdrop_identities'
      ].join('; '),
      'installer-home-collision',
      installerPath,
      collisionRoot,
      mutationLog
    ], { encoding: 'utf8' });
    assert.notEqual(freshCollision.status, 0);
    await assert.rejects(readFile(mutationLog), { code: 'ENOENT' });

    const partialUserCollision = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'validate_agent_identity_snapshot() { return 0; }',
        'IDENTITY_MARKER_DIR="$2/partial-marker"',
        'IDENTITY_MARKER="$IDENTITY_MARKER_DIR/managed-identities-v1"',
        'MUTATION_LOG="$3"',
        'getent() { if [[ $# -eq 1 ]]; then return 0; fi; if [[ "$1" == "passwd" && "$2" == "nightdrop" ]]; then printf "nightdrop:x:499:497::/home/nightdrop:/usr/sbin/nologin\\n"; return 0; fi; return 2; }',
        'groupadd() { printf "groupadd\\n" >> "$MUTATION_LOG"; }',
        'useradd() { printf "useradd\\n" >> "$MUTATION_LOG"; }',
        'usermod() { printf "usermod\\n" >> "$MUTATION_LOG"; }',
        'prepare_nightdrop_identities'
      ].join('; '),
      'installer-partial-user-collision',
      installerPath,
      collisionRoot,
      mutationLog
    ], { encoding: 'utf8' });
    assert.notEqual(partialUserCollision.status, 0);
    await assert.rejects(readFile(mutationLog), { code: 'ENOENT' });

    const collision = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'validate_agent_identity_snapshot() { return 0; }',
        'IDENTITY_MARKER_DIR="$2/marker"',
        'IDENTITY_MARKER="$IDENTITY_MARKER_DIR/managed-identities-v1"',
        'MUTATION_LOG="$3"',
        'id() { return 0; }',
        'getent() { if [[ $# -eq 1 ]]; then return 0; fi; printf "%s:x:498:nightdrop,hermes\\n" "$2"; }',
        'usermod() { printf "mutated\\n" >> "$MUTATION_LOG"; }',
        'AGENT_USER=hermes',
        'prepare_nightdrop_identities'
      ].join('; '),
      'installer-collision',
      installerPath,
      collisionRoot,
      mutationLog
    ], { encoding: 'utf8' });
    assert.notEqual(collision.status, 0);
    await assert.rejects(readFile(mutationLog), { code: 'ENOENT' });
  } finally {
    await rm(collisionRoot, { recursive: true, force: true });
  }
});

test('production installer behaviorally verifies agent access before service activation', async () => {
  const installer = await readFile(new URL('../scripts/install-production.sh', import.meta.url), 'utf8');
  const functionDefinition = installer.indexOf('verify_agent_access_boundary() {');
  const permissionSetup = installer.lastIndexOf('chmod 640 "$INSTALL_DIR/audit.log"');
  const probeCall = installer.lastIndexOf('if ! verify_agent_access_boundary; then');
  const unitWrite = installer.lastIndexOf('\nUNIT_WRITTEN=true');
  assert(functionDefinition >= 0, 'behavioral access probe must be defined');
  assert(probeCall > permissionSetup, 'access probe must run after protected permissions are applied');
  assert(unitWrite > probeCall, 'access probe must pass before the candidate unit can be activated');
  assert.match(installer, /runuser -u "\$AGENT_USER" -- env -i/);
  assert.match(installer, /validate_agent_access_probe_results/);
  assert.match(installer, /cleanup_agent_access_probe/);
});

test('production privilege and access probes distinguish denial from execution failure', async () => {
  const installerPath = fileURLToPath(new URL('../scripts/install-production.sh', import.meta.url));
  const detect = (healthStatus: number, sudoStatus: number, sudoOutput: string): number | null => spawnSync('/bin/bash', [
    '-c',
    [
      'source "$1"',
      'HEALTH_STATUS="$2"',
      'SUDO_STATUS="$3"',
      'SUDO_OUTPUT="$4"',
      'AGENT_USER=hermes',
      'AGENT_UID_SNAPSHOT=1000',
      'resolve_optional_trusted_executable() { if [[ "$1" == sudo ]]; then printf "/trusted/sudo\\n"; return 0; fi; return 1; }',
      'runuser() { if [[ " $* " == *" /trusted/sudo "* ]]; then printf "%s\\n" "$SUDO_OUTPUT"; return "$SUDO_STATUS"; fi; printf "1000\\n"; return "$HEALTH_STATUS"; }',
      'root_owned_path_writable_by_agent() { return 1; }',
      'detect_agent_privilege_risk'
    ].join('; '),
    'installer-privilege-probe',
    installerPath,
    String(healthStatus),
    String(sudoStatus),
    sudoOutput
  ], { encoding: 'utf8' }).status;

  assert.equal(detect(0, 0, 'User hermes may run the following commands:\n    (ALL : ALL) NOPASSWD: /usr/bin/systemctl restart nightdrop'), 0);
  assert.equal(detect(0, 0, 'User hermes may run the following commands:\n    (ALL : ALL) /usr/bin/id'), 1);
  assert.equal(detect(0, 1, 'sudo: a password is required'), 1);
  assert.equal(detect(0, 125, 'sudo: internal failure'), 2);
  assert.equal(detect(126, 0, '0'), 2);

  const accessFailure = spawnSync('/bin/bash', [
    '-c',
    'source "$1"; runuser() { return 126; }; agent_test_path_access -r /private',
    'installer-access-probe',
    installerPath
  ], { encoding: 'utf8' });
  assert.equal(accessFailure.status, 2);
});

test('production deployment profiles are explicit and security claims are scoped', async () => {
  const installerPath = fileURLToPath(new URL('../scripts/install-production.sh', import.meta.url));
  const [installer, watcher, readme, deployment, hermes, handoff, skill] = await Promise.all([
    readFile(installerPath, 'utf8'),
    readFile(new URL('../src/watcher.ts', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/deployment.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/hermes.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/credential-handoff.md', import.meta.url), 'utf8'),
    readFile(new URL('../skill/SKILL.md', import.meta.url), 'utf8')
  ]);
  assert.match(installer, /DEPLOYMENT_PROFILE="standard"/);
  assert.match(installer, /--deployment-profile standard\|strict/);
  assert.match(installer, /--acknowledge-agent-host-admin-risk/);
  assert.match(installer, /validate_privileged_agent_acknowledgment/);
  assert.match(installer, /Detected indicators: \$AGENT_PRIVILEGE_RISK_DETAILS/);
  assert.match(installer, /chown "root:\$SERVICE_GROUP" "\$INSTALL_DIR\/drafts"/);
  assert.match(watcher, /Buffer\.allocUnsafe\(MAX_DRAFT_SIZE_BYTES \+ 1\)/);
  assert.doesNotMatch(watcher, /source\.readFile/);
  for (const document of [readme, deployment]) {
    assert.match(document, /Standard/);
    assert.match(document, /Strict/);
    assert.match(document, /Isolated/);
    assert.match(document, /not (?:a )?(?:hard|structural)|does \*\*not\*\* qualify/i);
  }
  assert.match(readme, /Isolated reference architecture \(not shipped by the installer\)/);
  assert.match(deployment, /not selectable with `--deployment-profile`/);
  assert.match(deployment, /does not ship this transport or deployment automation/);
  assert.match(skill, /unshipped reference architecture/);
  assert.doesNotMatch(readme, /cannot list, read, edit, delete, or replace drafts after submission/);
  assert.match(readme, /Retained hard links cannot mutate the claimed copy/);
  assert.match(deployment, /retained hard links cannot modify that claimed copy/);
  assert.match(hermes, /optional high-assurance topology, not the normal installation requirement/);
  assert.match(handoff, /acknowledged privileged agent does not make that stronger claim/);
  assert.match(handoff, /workflow separation rather than a hard host boundary/);
  assert.match(skill, /hard structural boundary only when all of these are true/);
  assert.match(skill, /acknowledged root-equivalent Hermes account in standard mode/);

  for (const option of ['--agent-user', '--deployment-profile', '--telegram-user-id', '--install-dir']) {
    const missingValue = spawnSync('/bin/bash', [installerPath, option], { encoding: 'utf8' });
    assert.equal(missingValue.status, 2, `${option}: ${missingValue.stderr}`);
    assert.match(missingValue.stderr, /Missing value/);
  }
});

test('production installer retains rollback state until upgraded service is healthy', async () => {
  const installer = await readFile(new URL('../scripts/install-production.sh', import.meta.url), 'utf8');
  assert.match(installer, /restore_previous_deployment/);
  assert.match(installer, /PREVIOUS_APP_TREE/);
  assert.match(installer, /PREVIOUS_CONFIG/);
  assert.match(installer, /PREVIOUS_UNIT/);
  const healthCheck = installer.lastIndexOf('wait_for_service_ready "$SERVICE_NAME" "$READY_FILE"');
  const discardRollback = installer.lastIndexOf('rm -rf -- "$ROLLBACK_ROOT"');
  assert(healthCheck >= 0, 'installer must wait for PID-bound application readiness');
  assert(discardRollback > healthCheck, 'rollback state must survive until after the readiness check');
});

test('production deployment rollback restores enablement and retains failed recovery state', async () => {
  const scriptPath = fileURLToPath(new URL('../scripts/install-production.sh', import.meta.url));
  const root = await mkdtemp(join(tmpdir(), 'nightdrop-deployment-rollback-'));
  try {
    const completeRoot = join(root, 'complete');
    const completeLog = join(root, 'complete.log');
    await mkdir(completeRoot);
    const complete = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'ROLLBACK_ROOT="$2"',
        'SERVICE_NAME=nightdrop.service',
        'SERVICE_STOPPED=false',
        'APP_TREE_SYNCED=false',
        'UNIT_WRITTEN=false',
        'CONFIG_TOUCHED=false',
        'MAILBOX_CLI_TOUCHED=false',
        'PROTECTED_METADATA_SNAPSHOTTED=false',
        'UNIT_ENABLEMENT_TOUCHED=true',
        'SERVICE_ENABLEMENT_STATE=disabled',
        'SERVICE_WAS_ACTIVE=false',
        'SYSTEMCTL_STATE=disabled',
        'SYSTEMCTL_LOG="$3"',
        'systemctl() { if [[ "$1" == "is-enabled" ]]; then printf "%s\\n" "$SYSTEMCTL_STATE"; return 1; fi; printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"; if [[ "$1" == "disable" ]]; then SYSTEMCTL_STATE=disabled; fi; }',
        'cleanup_builder() { return 0; }',
        'perform_deployment_rollback 1'
      ].join('; '),
      'installer-complete-rollback',
      scriptPath,
      completeRoot,
      completeLog
    ], { encoding: 'utf8' });
    assert.equal(complete.status, 0, complete.stderr || complete.stdout);
    await assert.rejects(stat(completeRoot), { code: 'ENOENT' });
    assert.equal(await readFile(completeLog, 'utf8'), 'disable nightdrop.service\n');

    const failedRoot = join(root, 'failed');
    const failedApp = join(failedRoot, 'application-tree');
    await mkdir(failedApp, { recursive: true });
    const failed = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'ROLLBACK_ROOT="$2"',
        'PREVIOUS_APP_TREE="$3"',
        'SERVICE_NAME=nightdrop.service',
        'READY_FILE=/run/nightdrop/ready',
        'SERVICE_STOPPED=true',
        'APP_TREE_SYNCED=true',
        'UNIT_WRITTEN=false',
        'CONFIG_TOUCHED=false',
        'MAILBOX_CLI_TOUCHED=false',
        'PROTECTED_METADATA_SNAPSHOTTED=false',
        'UNIT_ENABLEMENT_TOUCHED=false',
        'SERVICE_WAS_ACTIVE=true',
        'systemctl() { return 0; }',
        'restore_application_tree() { return 1; }',
        'wait_for_service_ready() { return 0; }',
        'cleanup_builder() { return 0; }',
        'if perform_deployment_rollback 1; then exit 90; fi'
      ].join('; '),
      'installer-failed-rollback',
      scriptPath,
      failedRoot,
      failedApp
    ], { encoding: 'utf8' });
    assert.equal(failed.status, 0, failed.stderr || failed.stdout);
    assert.match(failed.stderr, /rollback was incomplete/);
    assert.equal((await stat(failedRoot)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed service stop still triggers prior-service rollback and restart', async () => {
  const installerPath = fileURLToPath(new URL('../scripts/install-production.sh', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-stop-rollback-'));
  try {
    const rollbackRoot = join(dir, 'rollback');
    const logPath = join(dir, 'systemctl.log');
    await mkdir(rollbackRoot);
    const result = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'ROLLBACK_ROOT="$2"',
        'SYSTEMCTL_LOG="$3"',
        'SERVICE_NAME=nightdrop.service',
        'READY_FILE=/run/nightdrop/ready',
        'SERVICE_WAS_ACTIVE=true',
        'SERVICE_STOPPED=false',
        'APP_TREE_SYNCED=false',
        'UNIT_WRITTEN=false',
        'CONFIG_TOUCHED=false',
        'MAILBOX_CLI_TOUCHED=false',
        'PROTECTED_METADATA_SNAPSHOTTED=false',
        'UNIT_ENABLEMENT_TOUCHED=false',
        'STOP_CALLS=0',
        'systemctl() { printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"; if [[ "$1" == stop ]]; then STOP_CALLS=$((STOP_CALLS + 1)); (( STOP_CALLS > 1 )); else return 0; fi; }',
        'wait_for_service_ready() { return 0; }',
        'cleanup_builder() { return 0; }',
        'if stop_previous_service; then exit 90; fi',
        '[[ "$SERVICE_STOPPED" == true ]]',
        'perform_deployment_rollback 1'
      ].join('; '),
      'installer-stop-rollback',
      installerPath,
      rollbackRoot,
      logPath
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(logPath, 'utf8'), [
      'stop nightdrop.service',
      'stop nightdrop.service',
      'start nightdrop.service',
      ''
    ].join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('partial transient useradd failure cleans the proven user and group', async () => {
  const installerPath = fileURLToPath(new URL('../scripts/install-production.sh', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-builder-partial-'));
  try {
    const logPath = join(dir, 'cleanup.log');
    const result = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'BUILD_USER=nightdrop-build-test',
        'BUILD_GROUP="$BUILD_USER"',
        'BUILD_HOME=/tmp/nightdrop-build-test-home',
        'BUILD_USER_CREATED=false',
        'BUILD_GROUP_CREATED=false',
        'BUILD_IDENTITY_OWNERSHIP_UNCERTAIN=false',
        'BUILD_UID=""',
        'BUILD_GID=""',
        'USER_STATE=absent',
        'GROUP_STATE=absent',
        'CLEANUP_LOG="$2"',
        'nss_entry_state() { if [[ "$1" == passwd ]]; then printf "%s\\n" "$USER_STATE"; else printf "%s\\n" "$GROUP_STATE"; fi; }',
        'getent() { if [[ "$1" == group ]]; then printf "nightdrop-build-test:x:4343:\\n"; elif [[ "$USER_STATE" == present ]]; then printf "nightdrop-build-test:x:4242:4343::/tmp/nightdrop-build-test-home:/usr/sbin/nologin\\n"; elif [[ $# -eq 1 ]]; then printf "root:x:0:0:root:/root:/bin/bash\\n"; else return 2; fi; }',
        'id() { case "$1" in -u) printf "4242\\n" ;; -gn|-Gn) printf "nightdrop-build-test\\n" ;; *) return 1 ;; esac; }',
        'groupadd() { GROUP_STATE=present; return 0; }',
        'useradd() { USER_STATE=present; return 1; }',
        'pkill() { printf "pkill %s\\n" "$*" >> "$CLEANUP_LOG"; }',
        'userdel() { printf "userdel %s\\n" "$*" >> "$CLEANUP_LOG"; USER_STATE=absent; }',
        'groupdel() { printf "groupdel %s\\n" "$*" >> "$CLEANUP_LOG"; GROUP_STATE=absent; }',
        'if create_builder_identity; then exit 90; fi',
        '[[ "$BUILD_USER_CREATED" == true && "$BUILD_GROUP_CREATED" == true && "$BUILD_UID" == 4242 && "$BUILD_GID" == 4343 ]]',
        'cleanup_builder_identity'
      ].join('; '),
      'installer-builder-partial',
      installerPath,
      logPath
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const cleanup = await readFile(logPath, 'utf8');
    assert.match(cleanup, /pkill -KILL -u 4242/);
    assert.match(cleanup, /userdel nightdrop-build-test/);
    assert.match(cleanup, /groupdel nightdrop-build-test/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('partial transient groupadd failure cleans only the proven group', async () => {
  const installerPath = fileURLToPath(new URL('../scripts/install-production.sh', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-builder-group-partial-'));
  try {
    const logPath = join(dir, 'cleanup.log');
    const result = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'BUILD_USER=nightdrop-build-test',
        'BUILD_GROUP="$BUILD_USER"',
        'BUILD_HOME=/tmp/nightdrop-build-test-home',
        'BUILD_USER_CREATED=false',
        'BUILD_GROUP_CREATED=false',
        'BUILD_IDENTITY_OWNERSHIP_UNCERTAIN=false',
        'BUILD_UID=""',
        'BUILD_GID=""',
        'GROUP_STATE=absent',
        'CLEANUP_LOG="$2"',
        'nss_entry_state() { if [[ "$1" == group ]]; then printf "%s\\n" "$GROUP_STATE"; else printf "absent\\n"; fi; }',
        'getent() { if [[ "$1" == group ]]; then printf "nightdrop-build-test:x:4343:\\n"; else printf "root:x:0:0:root:/root:/bin/bash\\n"; fi; }',
        'groupadd() { GROUP_STATE=present; return 1; }',
        'groupdel() { printf "groupdel %s\\n" "$*" >> "$CLEANUP_LOG"; GROUP_STATE=absent; }',
        'userdel() { printf "userdel %s\\n" "$*" >> "$CLEANUP_LOG"; }',
        'pkill() { printf "pkill %s\\n" "$*" >> "$CLEANUP_LOG"; }',
        'if create_builder_identity; then exit 90; fi',
        '[[ "$BUILD_USER_CREATED" == false && "$BUILD_GROUP_CREATED" == true && "$BUILD_GID" == 4343 ]]',
        'cleanup_builder_identity'
      ].join('; '),
      'installer-builder-group-partial',
      installerPath,
      logPath
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(logPath, 'utf8'), 'groupdel nightdrop-build-test\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('transient ownership mismatch or NSS uncertainty forbids user deletion', async () => {
  const installerPath = fileURLToPath(new URL('../scripts/install-production.sh', import.meta.url));
  for (const scenario of ['mismatch', 'nss-error']) {
    const dir = await mkdtemp(join(tmpdir(), `nightdrop-builder-${scenario}-`));
    try {
      const logPath = join(dir, 'cleanup.log');
      const result = spawnSync('/bin/bash', [
        '-c',
        [
          'source "$1"',
          'SCENARIO="$2"',
          'CLEANUP_LOG="$3"',
          'BUILD_USER=nightdrop-build-test',
          'BUILD_GROUP="$BUILD_USER"',
          'BUILD_HOME=/tmp/nightdrop-build-test-home',
          'BUILD_USER_CREATED=false',
          'BUILD_GROUP_CREATED=false',
          'BUILD_IDENTITY_OWNERSHIP_UNCERTAIN=false',
          'BUILD_UID=""',
          'BUILD_GID=""',
          'USER_STATE=absent',
          'GROUP_STATE=absent',
          'nss_entry_state() { if [[ "$1" == passwd && "$SCENARIO" == nss-error && "$USER_STATE" == present ]]; then return 3; fi; if [[ "$1" == passwd ]]; then printf "%s\\n" "$USER_STATE"; else printf "%s\\n" "$GROUP_STATE"; fi; }',
          'getent() { if [[ "$1" == group ]]; then printf "nightdrop-build-test:x:4343:\\n"; elif [[ "$USER_STATE" == present ]]; then printf "nightdrop-build-test:x:4242:4343::/tmp/nightdrop-build-test-home:/bin/bash\\n"; elif [[ $# -eq 1 ]]; then printf "root:x:0:0:root:/root:/bin/bash\\n"; else return 2; fi; }',
          'id() { case "$1" in -u) printf "4242\\n" ;; -gn|-Gn) printf "nightdrop-build-test\\n" ;; *) return 1 ;; esac; }',
          'groupadd() { GROUP_STATE=present; }',
          'useradd() { USER_STATE=present; return 1; }',
          'pkill() { printf "pkill %s\\n" "$*" >> "$CLEANUP_LOG"; }',
          'userdel() { printf "userdel %s\\n" "$*" >> "$CLEANUP_LOG"; USER_STATE=absent; }',
          'groupdel() { printf "groupdel %s\\n" "$*" >> "$CLEANUP_LOG"; GROUP_STATE=absent; }',
          'if create_builder_identity; then exit 90; fi',
          '[[ "$BUILD_IDENTITY_OWNERSHIP_UNCERTAIN" == true && "$BUILD_USER_CREATED" == false ]]',
          'if cleanup_builder_identity; then exit 91; fi'
        ].join('; '),
        'installer-builder-refusal',
        installerPath,
        scenario,
        logPath
      ], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${scenario}: ${result.stderr || result.stdout}`);
      await assert.rejects(stat(logPath), { code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('mailbox rollback verification detects byte and metadata drift', async () => {
  const installerPath = fileURLToPath(new URL('../scripts/install-production.sh', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-mailbox-metadata-'));
  try {
    const sourceDir = join(dir, 'source');
    const destinationDir = join(dir, 'destination');
    await mkdir(sourceDir);
    await mkdir(destinationDir);
    const source = join(sourceDir, 'nightdrop-mailbox');
    const destination = join(destinationDir, 'nightdrop-mailbox');
    await writeFile(source, 'trusted mailbox bytes\n', { mode: 0o640 });
    const copied = spawnSync('/bin/cp', ['-a', source, destination], { encoding: 'utf8' });
    assert.equal(copied.status, 0, copied.stderr);
    const verify = (path: string): number | null => spawnSync('/bin/bash', [
      '-c', 'source "$1"; verify_restored_file "$2" "$3"',
      'installer-mailbox-metadata', installerPath, source, path
    ], { encoding: 'utf8' }).status;
    assert.equal(verify(destination), 0);
    await chmod(destination, 0o600);
    assert.notEqual(verify(destination), 0);
    const restored = spawnSync('/bin/cp', ['-a', source, destination], { encoding: 'utf8' });
    assert.equal(restored.status, 0, restored.stderr);
    await writeFile(destination, 'tampered mailbox data\n');
    await chmod(destination, 0o640);
    const sourceMetadata = await stat(source);
    await utimes(destination, sourceMetadata.atime, sourceMetadata.mtime);
    assert.equal((await stat(destination)).size, sourceMetadata.size);
    assert.notEqual(verify(destination), 0);
    const installer = await readFile(installerPath, 'utf8');
    assert.match(installer, /rsync -aAXnc --numeric-ids --itemize-changes/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed mailbox metadata verification retains rollback recovery state', async () => {
  const installerPath = fileURLToPath(new URL('../scripts/install-production.sh', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-mailbox-rollback-'));
  try {
    const rollbackRoot = join(dir, 'rollback');
    const previous = join(rollbackRoot, 'nightdrop-mailbox');
    const destination = join(dir, 'nightdrop-mailbox');
    await mkdir(rollbackRoot);
    await writeFile(previous, 'previous\n');
    await writeFile(destination, 'candidate\n');
    const result = spawnSync('/bin/bash', [
      '-c',
      [
        'source "$1"',
        'ROLLBACK_ROOT="$2"',
        'PREVIOUS_MAILBOX_CLI="$3"',
        'MAILBOX_CLI_PATH="$4"',
        'MAILBOX_CLI_TOUCHED=true',
        'MAILBOX_CLI_EXISTED=true',
        'SERVICE_STOPPED=false',
        'APP_TREE_SYNCED=false',
        'UNIT_WRITTEN=false',
        'CONFIG_TOUCHED=false',
        'PROTECTED_METADATA_SNAPSHOTTED=false',
        'UNIT_ENABLEMENT_TOUCHED=false',
        'SERVICE_WAS_ACTIVE=false',
        'verify_restored_file() { return 1; }',
        'cleanup_builder() { return 0; }',
        'if perform_deployment_rollback 1; then exit 90; fi'
      ].join('; '),
      'installer-mailbox-rollback', installerPath, rollbackRoot, previous, destination
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    await stat(rollbackRoot);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('production installer rsync preserves rollback snapshots', async () => {
  const scriptPath = fileURLToPath(new URL('../scripts/install-production.sh', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-rsync-rollback-'));
  const source = join(dir, 'source');
  const install = join(dir, 'install');
  const rollbackFile = join(install, '.rollback-12345678', 'config.yaml');
  try {
    await mkdir(source);
    await mkdir(join(install, '.rollback-12345678'), { recursive: true });
    await writeFile(join(source, 'new-runtime'), 'new', 'utf8');
    await writeFile(rollbackFile, 'previous-config', 'utf8');
    const user = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
    const group = spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout.trim();
    const sync = spawnSync('bash', [
      '-c',
      'source "$1"; SOURCE_DIR="$2"; INSTALL_DIR="$3"; sync_application_tree "$4"',
      'bash', scriptPath, source, install, `${user}:${group}`
    ], { encoding: 'utf8' });
    assert.equal(sync.status, 0, sync.stderr || sync.stdout);
    assert.equal(await readFile(rollbackFile, 'utf8'), 'previous-config');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('interactive selection is explicit, bounded, and terminal-safe', () => {
  assert.equal(parseSelection('2', 3), 1);
  assert.throws(() => parseSelection('0', 3), /between 1 and 3/);
  assert.throws(() => parseSelection('4', 3), /between 1 and 3/);
  assert.throws(() => parseSelection('1.5', 3), /between 1 and 3/);
  assert.equal(sanitizeTerminalText('safe\u001b[31mred\u0007\u202Eevil'), 'safe[31mredevil');
});

test('Gmail authorization URL requests send and basic identity scopes with PKCE and state', () => {
  const url = new URL(buildGmailAuthorizationUrl({
    clientId: 'google-client-id',
    redirectUri: 'http://127.0.0.1:8765/',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }));

  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'google-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8765/');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/gmail.send');
  assert.equal(url.searchParams.get('access_type'), null);
  assert.equal(url.searchParams.get('include_granted_scopes'), null);
  assert.equal(url.searchParams.get('prompt'), 'consent select_account');
  assert.equal(url.searchParams.get('code_challenge'), 'pkce-challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.throws(() => buildGmailAuthorizationUrl({
    clientId: 'google-client-id',
    redirectUri: 'http://user@127.0.0.1:8765/',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }), /loopback root/);
  assert.throws(() => buildGmailAuthorizationUrl({
    clientId: 'google-client-id',
    redirectUri: 'http://127.0.0.1:8765/?unexpected=1',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }), /loopback root/);
});

test('Gmail exchanges a public-client code with PKCE and verifies returned scopes', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      scope: 'email https://www.googleapis.com/auth/gmail.send openid'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;

  const tokens = await exchangeGmailAuthorizationCode({
    clientId: 'google-client-id',
    code: 'authorization-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: 'http://127.0.0.1:8765/'
  }, fetchFn);

  assert.deepEqual(tokens, { accessToken: 'access-token', refreshToken: 'refresh-token' });
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(calls[0].init?.redirect, 'error');
  assert(calls[0].init?.signal instanceof AbortSignal);
  const body = calls[0].init?.body as URLSearchParams;
  assert.equal(body.get('code'), 'authorization-code');
  assert.equal(body.get('code_verifier'), 'pkce-verifier');
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_secret'), null);
});

test('Gmail rejects a token response missing an approved required scope', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    scope: 'openid email'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

  await assert.rejects(() => exchangeGmailAuthorizationCode({
    clientId: 'google-client-id',
    code: 'authorization-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: 'http://127.0.0.1:8765/'
  }, fetchFn), /missing required scope/);
});

test('Gmail OIDC identity lookup returns a verified authenticated address', async () => {
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://openidconnect.googleapis.com/v1/userinfo');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer temporary-access-token');
    assert.equal(init?.redirect, 'error');
    assert(init?.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ email: 'owner@gmail.com', email_verified: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;

  assert.equal(await fetchGmailIdentity('temporary-access-token', fetchFn), 'owner@gmail.com');
});

test('Gmail OIDC identity rejects terminal-control characters in email metadata', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    email: 'owner@gmail.com\u001b[31m',
    email_verified: true
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

  await assert.rejects(() => fetchGmailIdentity('temporary-access-token', fetchFn), /verified email address/);
});

test('Outlook authorization URL uses a public-client loopback redirect, PKCE, and state', () => {
  const url = new URL(buildOutlookAuthorizationUrl({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    redirectUri: 'http://localhost:8765/microsoft/oauth/callback',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }));

  assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('client_id'), 'microsoft-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8765/microsoft/oauth/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('response_mode'), 'query');
  assert.equal(url.searchParams.get('scope'), 'offline_access Mail.Send User.Read');
  const mailboxUrl = new URL(buildOutlookAuthorizationUrl({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    redirectUri: 'http://localhost:8765/microsoft/oauth/callback',
    state: 'state-value',
    codeChallenge: 'pkce-challenge',
    mailboxAccess: true
  }));
  assert.equal(mailboxUrl.searchParams.get('scope'), 'offline_access Mail.Send Mail.ReadWrite User.Read');
  assert.equal(url.searchParams.get('code_challenge'), 'pkce-challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.throws(() => buildOutlookAuthorizationUrl({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    redirectUri: 'http://user@localhost:8765/microsoft/oauth/callback',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }), /registered localhost callback/);
  assert.throws(() => buildOutlookAuthorizationUrl({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    redirectUri: 'http://localhost:8765/microsoft/oauth/callback#fragment',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }), /registered localhost callback/);
});

test('Outlook exchanges a public-client authorization code with PKCE', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      scope: 'Mail.Send User.Read'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  assert.deepEqual(await exchangeOutlookAuthorizationCode({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    code: 'authorization-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: 'http://localhost:8765/microsoft/oauth/callback'
  }, fetchFn), { accessToken: 'access-token', refreshToken: 'refresh-token' });

  assert.equal(calls[0].url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  assert.equal(calls[0].init?.redirect, 'error');
  const body = calls[0].init?.body as URLSearchParams;
  assert.equal(body.get('code'), 'authorization-code');
  assert.equal(body.get('code_verifier'), 'pkce-verifier');
  assert.equal(body.get('client_secret'), null);
  assert(calls[0].init?.signal instanceof AbortSignal);
});

test('Outlook rejects mailbox authorization without the delegated Mail.ReadWrite scope', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    scope: 'Mail.Send User.Read'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

  await assert.rejects(() => exchangeOutlookAuthorizationCode({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    code: 'authorization-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: 'http://localhost:8765/microsoft/oauth/callback',
    mailboxAccess: true
  }, fetchFn), /missing required scope/);
});

test('Outlook accepts an omitted scope field after requesting the fixed approved scope set', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'refresh-token'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

  assert.deepEqual(await exchangeOutlookAuthorizationCode({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    code: 'authorization-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: 'http://localhost:8765/microsoft/oauth/callback'
  }, fetchFn), { accessToken: 'access-token', refreshToken: 'refresh-token' });
});

test('Outlook device authorization requests only offline mail-send and profile scopes', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      device_code: 'device-code',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 900,
      interval: 5,
      message: 'Open the browser and enter the code.'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const result = await requestOutlookDeviceCode({ clientId: 'microsoft-client-id', tenantId: 'common' }, fetchFn);
  assert.equal(result.deviceCode, 'device-code');
  assert.equal(result.userCode, 'ABCD-EFGH');
  assert.equal(result.verificationUri, 'https://microsoft.com/devicelogin');
  assert.equal(calls[0].url, 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode');
  assert.equal(calls[0].init?.redirect, 'error');
  assert(calls[0].init?.signal instanceof AbortSignal);
  const body = calls[0].init?.body as URLSearchParams;
  assert.equal(body.get('client_id'), 'microsoft-client-id');
  assert.equal(body.get('scope'), 'offline_access Mail.Send User.Read');
});

test('Outlook device authorization rejects a non-Microsoft verification URI', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    device_code: 'device-code',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://attacker.example/phish',
    expires_in: 900,
    interval: 5
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

  await assert.rejects(
    () => requestOutlookDeviceCode({ clientId: 'microsoft-client-id', tenantId: 'common' }, fetchFn),
    /trusted Microsoft HTTPS URL/
  );
});

test('Outlook device token polling handles pending and slow_down without exposing tokens', async () => {
  const responses = [
    new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({ error: 'slow_down' }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', scope: 'Mail.Send User.Read' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  ];
  const delays: number[] = [];
  const fetchFn = (async () => responses.shift()!) as typeof fetch;
  const sleepFn = async (milliseconds: number) => { delays.push(milliseconds); };

  const tokens = await pollOutlookDeviceToken({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    deviceCode: 'device-code',
    expiresIn: 900,
    interval: 5
  }, fetchFn, sleepFn);

  assert.deepEqual(tokens, { accessToken: 'access-token', refreshToken: 'refresh-token' });
  assert.deepEqual(delays, [5_000, 5_000, 10_000]);
});

test('Outlook device token polling backs off after a transient network failure', async () => {
  const delays: number[] = [];
  let attempt = 0;
  const fetchFn = (async () => {
    attempt += 1;
    if (attempt === 1) throw new TypeError('simulated network failure');
    return new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      scope: 'Mail.Send User.Read'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const tokens = await pollOutlookDeviceToken({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    deviceCode: 'device-code',
    expiresIn: 900,
    interval: 5
  }, fetchFn, async (milliseconds: number) => { delays.push(milliseconds); });

  assert.deepEqual(tokens, { accessToken: 'access-token', refreshToken: 'refresh-token' });
  assert.deepEqual(delays, [5_000, 10_000]);
});

test('Outlook device polling never sleeps or requests beyond the authorization deadline', async () => {
  let now = 0;
  let fetchCalls = 0;
  const delays: number[] = [];
  const fetchFn = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ error: 'expired_token' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;
  const sleepFn = async (milliseconds: number) => {
    delays.push(milliseconds);
    now += milliseconds;
  };

  await assert.rejects(() => pollOutlookDeviceToken({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    deviceCode: 'device-code',
    expiresIn: 2,
    interval: 5
  }, fetchFn, sleepFn, () => now), /expired/);

  assert.deepEqual(delays, [2_000]);
  assert.equal(fetchCalls, 0);
});

test('Outlook identity lookup prefers mail and falls back to userPrincipalName', async () => {
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer temporary-access-token');
    return new Response(JSON.stringify({
      mail: 'owner@outlook.com',
      userPrincipalName: 'owner@example.onmicrosoft.com',
      displayName: 'Hash Bringer'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  assert.deepEqual(await fetchOutlookIdentity('temporary-access-token', fetchFn), {
    email: 'owner@outlook.com',
    displayName: 'Hash Bringer'
  });
});

test('Outlook identity rejects control characters and sanitizes display metadata', async () => {
  const unsafeEmailFetch = (async () => new Response(JSON.stringify({
    mail: 'owner@outlook.com\u001b[31m',
    displayName: 'Hash Bringer'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  await assert.rejects(() => fetchOutlookIdentity('temporary-access-token', unsafeEmailFetch), /valid mailbox address/);

  const unsafeNameFetch = (async () => new Response(JSON.stringify({
    mail: 'owner@outlook.com',
    displayName: 'Hash\u001b[31m\u202E Bringer'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  assert.deepEqual(await fetchOutlookIdentity('temporary-access-token', unsafeNameFetch), {
    email: 'owner@outlook.com',
    displayName: 'Hash[31m Bringer'
  });
});

test('Zoho authorization is pinned to explicit Accounts/Mail data-center pairs', () => {
  const expected = {
    us: ['https://accounts.zoho.com', 'https://mail.zoho.com'],
    eu: ['https://accounts.zoho.eu', 'https://mail.zoho.eu'],
    in: ['https://accounts.zoho.in', 'https://mail.zoho.in'],
    au: ['https://accounts.zoho.com.au', 'https://mail.zoho.com.au'],
    jp: ['https://accounts.zoho.jp', 'https://mail.zoho.jp'],
    ca: ['https://accounts.zohocloud.ca', 'https://mail.zohocloud.ca'],
    sa: ['https://accounts.zoho.sa', 'https://mail.zoho.sa']
  } as const;
  for (const [region, [accountsBaseUrl, mailApiBaseUrl]] of Object.entries(expected)) {
    assert.deepEqual(getZohoRegionEndpoints(region as keyof typeof expected), { accountsBaseUrl, mailApiBaseUrl });
  }
  for (const unmapped of ['uk', 'sg', 'cn', 'ae', 'inec', 'https://attacker.example']) {
    assert.throws(() => getZohoRegionEndpoints(unmapped as any), /Unsupported Zoho region/);
  }

  const url = new URL(buildZohoAuthorizationUrl({
    region: 'eu',
    clientId: 'zoho-client-id',
    redirectUri: 'http://127.0.0.1:8765/zoho/oauth/callback',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }));
  assert.equal(url.origin + url.pathname, 'https://accounts.zoho.eu/oauth/v2/auth');
  assert.equal(url.searchParams.get('scope'), 'ZohoMail.messages.CREATE,ZohoMail.accounts.READ');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('code_challenge'), 'pkce-challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.throws(() => buildZohoAuthorizationUrl({
    region: 'eu',
    clientId: 'zoho-client-id',
    redirectUri: 'http://user@127.0.0.1:8765/zoho/oauth/callback',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }), /exact local Zoho callback/);
  assert.throws(() => buildZohoAuthorizationUrl({
    region: 'eu',
    clientId: 'zoho-client-id',
    redirectUri: 'http://127.0.0.1:8765/zoho/oauth/callback?unexpected=1',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }), /exact local Zoho callback/);
});

test('Zoho exchanges an authorization code at the selected data center', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      api_domain: 'https://www.zohoapis.eu',
      token_type: 'Bearer',
      expires_in: 3600
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;

  const tokens = await exchangeZohoAuthorizationCode({
    region: 'eu',
    clientId: 'zoho-client-id',
    clientSecret: 'zoho-client-secret',
    code: 'authorization-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: 'http://127.0.0.1:8765/zoho/oauth/callback'
  }, fetchFn);
  assert.deepEqual(tokens, { accessToken: 'access-token', refreshToken: 'refresh-token' });
  assert.equal(calls[0].url, 'https://accounts.zoho.eu/oauth/v2/token');
  assert.equal(calls[0].init?.redirect, 'error');
  const body = calls[0].init?.body as URLSearchParams;
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'authorization-code');
  assert.equal(body.get('code_verifier'), 'pkce-verifier');
  assert.equal(body.get('scope'), null);
  assert(calls[0].init?.signal instanceof AbortSignal);
});

test('Zoho rejects a token response that does not prove the required grants', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    scope: 'ZohoMail.accounts.READ'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

  await assert.rejects(() => exchangeZohoAuthorizationCode({
    region: 'eu',
    clientId: 'zoho-client-id',
    clientSecret: 'zoho-client-secret',
    code: 'authorization-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: 'http://127.0.0.1:8765/zoho/oauth/callback'
  }, fetchFn), /missing required scope/);
});

test('Zoho account lookup returns explicit confirmed sender choices', async () => {
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://mail.zoho.eu/api/accounts');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Zoho-oauthtoken temporary-access-token');
    assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify({
      data: [
        {
          accountId: '123456789',
          displayName: 'Hash Bringer',
          primaryEmailAddress: 'owner@example.eu',
          emailAddress: [
            { mailId: 'unconfirmed@example.eu', isPrimary: false, isConfirmed: false },
            { mailId: 'alias@example.eu', isPrimary: false, isConfirmed: true }
          ],
          sendMailDetails: [
            { fromAddress: 'sales@example.eu', isEnabled: true },
            { fromAddress: 'disabled@example.eu', isEnabled: false },
            { fromAddress: 'ambiguous@example.eu' }
          ]
        },
        {
          accountId: '987654321',
          displayName: 'Second Account',
          primaryEmailAddress: 'second@example.eu'
        },
        {
          accountId: '555555555',
          displayName: 'Disabled Account',
          accountStatus: 'inactive',
          primaryEmailAddress: 'disabled-account@example.eu',
          sendMailDetails: [{ fromAddress: 'disabled-sender@example.eu', isEnabled: true }]
        }
      ]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  assert.deepEqual(await fetchZohoSenderChoices('eu', 'temporary-access-token', fetchFn), [
    { accountId: '123456789', email: 'owner@example.eu', displayName: 'Hash Bringer' },
    { accountId: '123456789', email: 'alias@example.eu', displayName: 'Hash Bringer' },
    { accountId: '123456789', email: 'sales@example.eu', displayName: 'Hash Bringer' },
    { accountId: '987654321', email: 'second@example.eu', displayName: 'Second Account' }
  ]);
});

test('Zoho account lookup rejects unsafe account identifiers and sanitizes display metadata', async () => {
  const unsafeAccountFetch = (async () => new Response(JSON.stringify({
    data: [{ accountId: '123\u001b[31m', primaryEmailAddress: 'owner@example.eu' }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  await assert.rejects(
    () => fetchZohoSenderChoices('eu', 'temporary-access-token', unsafeAccountFetch),
    /eligible account and sender address/
  );

  const unsafeNameFetch = (async () => new Response(JSON.stringify({
    data: [{
      accountId: '123456789',
      primaryEmailAddress: 'owner@example.eu',
      displayName: 'Hash\u001b[31m\u202E Bringer'
    }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  assert.deepEqual(await fetchZohoSenderChoices('eu', 'temporary-access-token', unsafeNameFetch), [{
    accountId: '123456789',
    email: 'owner@example.eu',
    displayName: 'Hash[31m Bringer'
  }]);
});

test('Zoho callback regional hints must match the selected allowlisted data center', () => {
  assert.doesNotThrow(() => validateZohoCallbackRegion('eu', {
    location: 'EU',
    accountsServer: 'https://accounts.zoho.eu'
  }));
  assert.throws(() => validateZohoCallbackRegion('eu', { location: 'us' }), /does not match/);
  assert.throws(
    () => validateZohoCallbackRegion('eu', { accountsServer: 'https://attacker.example' }),
    /does not match/
  );
  assert.throws(
    () => validateZohoCallbackRegion('eu', { accountsServer: 'https://user@accounts.zoho.eu' }),
    /does not match/
  );
});

test('OAuth callback enforces path/state, returns allowed metadata, and stops after one success', async () => {
  const listener = await createOAuthCallbackListener({
    expectedState: 'expected-state',
    callbackPath: '/zoho/oauth/callback',
    port: 0,
    timeoutMs: 2_000
  });
  try {
    const wrongPath = await fetch(listener.redirectUri.replace('/zoho/oauth/callback', '/callback') + '?code=attacker-code&state=expected-state');
    assert.equal(wrongPath.status, 404);

    const wrongMethod = await fetch(listener.redirectUri, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);

    const missingCode = await fetch(`${listener.redirectUri}?state=expected-state`);
    assert.equal(missingCode.status, 400);

    const wrongState = await fetch(`${listener.redirectUri}?code=attacker-code&state=wrong-state`);
    assert.equal(wrongState.status, 400);
    assert.match(await wrongState.text(), /state/i);

    const duplicateState = await fetch(`${listener.redirectUri}?code=attacker-code&state=expected-state&state=wrong-state`);
    assert.equal(duplicateState.status, 400);
    assert.match(await duplicateState.text(), /duplicate/i);

    const duplicateCode = await fetch(`${listener.redirectUri}?code=attacker-code&code=second-code&state=expected-state`);
    assert.equal(duplicateCode.status, 400);
    assert.match(await duplicateCode.text(), /duplicate/i);

    const accepted = fetch(`${listener.redirectUri}?code=valid-code&state=expected-state&location=eu&accounts-server=https%3A%2F%2Faccounts.zoho.eu`);
    assert.deepEqual(await listener.result, {
      code: 'valid-code',
      location: 'eu',
      accountsServer: 'https://accounts.zoho.eu'
    });
    assert.equal((await accepted).status, 200);

    await assert.rejects(() => fetch(`${listener.redirectUri}?code=second-code&state=expected-state`));
  } finally {
    await listener.close();
  }
});

test('OAuth callback does not expose provider error descriptions', async () => {
  const listener = await createOAuthCallbackListener({
    expectedState: 'expected-state',
    callbackPath: '/test/oauth/callback',
    port: 0,
    timeoutMs: 2_000
  });
  try {
    const responsePromise = fetch(`${listener.redirectUri}?error=access_denied&error_description=secret-provider-detail&state=expected-state`);
    await assert.rejects(listener.result, (error: unknown) => {
      assert(error instanceof Error);
      assert.doesNotMatch(error.message, /secret-provider-detail/);
      return true;
    });
    assert.equal((await responsePromise).status, 400);
  } finally {
    await listener.close();
  }
});

test('pass secret store sends the secret through stdin and never command arguments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-pass-test-'));
  try {
    const executable = join(dir, 'fake-pass');
    const argsPath = join(dir, 'args.txt');
    const stdinPath = join(dir, 'stdin.txt');
    await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_PASS_ARGS"\ncat > "$FAKE_PASS_STDIN"\n', 'utf8');
    await chmod(executable, 0o700);

    const secret = 'refresh-token-value-that-must-not-be-in-argv';
    const store = new PassSecretStore({
      executable,
      env: { ...process.env, FAKE_PASS_ARGS: argsPath, FAKE_PASS_STDIN: stdinPath }
    });
    await store.set('nightdrop/google-refresh-token', secret);

    const args = await readFile(argsPath, 'utf8');
    assert.equal(args, 'insert\n--force\n--multiline\nnightdrop/google-refresh-token\n');
    assert.doesNotMatch(args, /refresh-token-value/);
    assert.equal(await readFile(stdinPath, 'utf8'), `${secret}\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pass secret store uses the pinned environment executable instead of PATH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-pass-pinned-'));
  try {
    const pathDir = join(dir, 'path');
    await mkdir(pathDir);
    const pinnedExecutable = join(dir, 'pinned-pass');
    const pathExecutable = join(pathDir, 'pass');
    const markerPath = join(dir, 'selection.txt');
    await writeFile(
      pinnedExecutable,
      '#!/bin/sh\nprintf pinned > "$FAKE_PASS_SELECTION"\nIFS= read -r _\n',
      'utf8'
    );
    await writeFile(
      pathExecutable,
      '#!/bin/sh\nprintf path-search > "$FAKE_PASS_SELECTION"\nIFS= read -r _\n',
      'utf8'
    );
    await chmod(pinnedExecutable, 0o700);
    await chmod(pathExecutable, 0o700);

    const store = new PassSecretStore({
      env: {
        NIGHTDROP_PASS_BIN: pinnedExecutable,
        PATH: pathDir,
        FAKE_PASS_SELECTION: markerPath
      }
    });
    await store.set('nightdrop/outlook-refresh-token', 'rotation-value');
    assert.equal(await readFile(markerPath, 'utf8'), 'pinned');

    assert.throws(() => new PassSecretStore({ executable: 'pass' }), /must be absolute/);
    assert.throws(
      () => new PassSecretStore({ env: { NIGHTDROP_PASS_BIN: 'pass' } }),
      /must be absolute/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pass secret store rejects terminal-control characters before spawning', async () => {
  const store = new PassSecretStore({ executable: '/bin/false' });
  await assert.rejects(
    () => store.set('nightdrop/test-secret', 'secret\u202Evalue'),
    /printable single-line/
  );
});

test('pass secret store times out a hung password-store process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-pass-timeout-'));
  try {
    const executable = join(dir, 'hung-pass');
    await writeFile(executable, '#!/bin/sh\nsleep 30\n', 'utf8');
    await chmod(executable, 0o700);
    const store = new PassSecretStore({ executable, env: process.env, timeoutMs: 50 });

    await assert.rejects(
      () => store.set('nightdrop/google-refresh-token', 'temporary-test-token'),
      /timed out/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('production OAuth wrapper is root-protected and starts Nightdrop with a clean environment', async () => {
  const wrapper = await readFile(new URL('../scripts/oauth-setup.sh', import.meta.url), 'utf8');
  const manualHelper = await readFile(new URL('../scripts/configure-provider-secrets.sh', import.meta.url), 'utf8');
  const installer = await readFile(new URL('../scripts/install-production.sh', import.meta.url), 'utf8');
  const oauthCli = await readFile(new URL('../src/oauth-setup.ts', import.meta.url), 'utf8');

  assert.match(wrapper, /"\$RUNUSER_BIN" -u "\$SERVICE_USER" -- "\$ENV_BIN" -i/);
  assert.match(wrapper, /readonly TRUSTED_PATH=/);
  assert.match(wrapper, /validate_trusted_path/);
  assert.match(wrapper, /resolve_trusted_executable id/);
  assert.match(wrapper, /\[\[ "\$current" == "\/" \]\] && break/);
  assert.match(wrapper, /resolve_trusted_executable node/);
  assert.match(wrapper, /resolve_trusted_executable runuser/);
  assert.match(wrapper, /resolve_trusted_executable env/);
  assert.match(wrapper, /resolve_trusted_executable pass/);
  assert.match(wrapper, /NIGHTDROP_PASS_BIN="\$PASS_BIN"/);
  assert.match(wrapper, /resolve_trusted_executable systemctl/);
  assert.match(wrapper, /resolve_trusted_executable sleep/);
  assert.match(wrapper, /healthy_checks=/);
  assert.match(wrapper, /"\$SYSTEMCTL_BIN" is-active --quiet "\$SERVICE_NAME"/);
  assert.match(wrapper, /CONFIG_PATH="\$INSTALL_DIR\/config\/config\.yaml"/);
  assert.doesNotMatch(wrapper, /NIGHTDROP_CONFIG:-/);
  assert.match(installer, /SOURCE_DIR=.*BASH_SOURCE/);
  assert.match(installer, /"\$SOURCE_DIR"\/ "\$INSTALL_DIR"\//);
  assert.match(installer, /Refusing symbolic link at protected install path/);
  assert.match(installer, /local ownership="root:root"/);
  assert.match(installer, /rsync -a --delete --chown="\$ownership"/);
  assert.match(installer, /\nsync_application_tree\n/);
  assert.doesNotMatch(installer, /chown -R root:root "\$INSTALL_DIR"/);
  assert.match(installer, /chmod 711 "\$INSTALL_DIR"/);
  assert.match(installer, /chown root:root "\$INSTALL_DIR\/scripts"/);
  assert.match(installer, /chmod 755 "\$INSTALL_DIR\/scripts"/);
  assert.match(installer, /chown root:root[\s\\]+"\$INSTALL_DIR\/scripts\/oauth-setup\.sh"/);
  assert.match(installer, /chown -R "\$SERVICE_USER:\$SERVICE_GROUP" "\$CONFIG_DIR"/);
  assert.match(installer, /Environment=NIGHTDROP_CONFIG=\$CONFIG_DIR\/config\.yaml/);
  assert.match(installer, /BUILD_USER="nightdrop-build-\$\$"/);
  assert.match(installer, /"\$ENV_BIN" -i[\s\S]*?"\$NPM_BIN" ci/);
  assert.match(installer, /runuser -u "\$BUILD_USER" -- env -i/);
  assert.doesNotMatch(installer, /runuser -u "\$SERVICE_USER" -- env -i[\s\S]*?npm/);
  assert.match(installer, /find "\$BUILD_ROOT\/dist" -type l -print -quit/);
  assert.doesNotMatch(installer, /chown -R "\$SERVICE_USER:\$SERVICE_GROUP" "\$INSTALL_DIR"/);
  assert.match(manualHelper, /if \[\[ ! -t 0 \|\| ! -t 1 \]\]/);
  assert.match(manualHelper, /resolve_trusted_executable pass/);
  assert.match(manualHelper, /resolve_trusted_executable id/);
  assert.match(manualHelper, /\[\[ "\$current" == "\/" \]\] && break/);
  assert.match(manualHelper, /resolve_trusted_executable timeout/);
  assert.match(manualHelper, /resolve_trusted_executable runuser/);
  assert.match(manualHelper, /resolve_trusted_executable env/);
  assert.match(manualHelper, /"\$TIMEOUT_BIN" --kill-after=5s 30s "\$RUNUSER_BIN"/);
  assert.match(manualHelper, /"\$PASS_BIN" insert --force --multiline/);
});

test('provider config update is atomic, contains pass references, and remains mode 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-oauth-config-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, `
telegram:
  botToken: "\${PASS:nightdrop/telegram-bot-token}"
  allowedUsers: [2061243435]
watch:
  directory: ./drafts/inbox
providers:
  log:
    type: log-only
defaults:
  provider: log
  timezone: UTC
audit:
  enabled: true
  logFile: ./audit.log
`, { encoding: 'utf8', mode: 0o600 });

    await updateProviderConfig(configPath, 'gmail', {
      type: 'email-gmail',
      clientId: '${PASS:nightdrop/google-client-id}',
      refreshToken: '${PASS:nightdrop/google-refresh-token}',
      fromAddress: 'owner@gmail.com'
    }, true);

    const parsed = YAML.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(parsed.providers.gmail.refreshToken, '${PASS:nightdrop/google-refresh-token}');
    assert.equal(parsed.providers.gmail.fromAddress, 'owner@gmail.com');
    assert.equal(parsed.defaults.provider, 'gmail');
    assert.equal((await lstat(configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider config writer rejects group/world-readable targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-oauth-mode-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'providers: {}\ndefaults: {}\n', { mode: 0o644 });
    await assert.rejects(
      () => updateProviderConfig(configPath, 'gmail', { type: 'email-gmail' }, false),
      /mode 0600/
    );
    await chmod(configPath, 0o400);
    await assert.rejects(
      () => validateProviderConfigTarget(configPath),
      /mode 0600/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuth persistence validates private config before writing any secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-oauth-preflight-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'providers: {}\ndefaults: {}\n', { mode: 0o644 });
    const writes: string[] = [];
    const store = { set: async (key: string) => { writes.push(key); } };

    await assert.rejects(() => persistGmailOnboarding({
      configPath,
      store,
      clientId: 'google-client-id',
      refreshToken: 'refresh-token',
      email: 'owner@gmail.com',
      setAsDefault: false
    }), /mode 0600/);
    assert.deepEqual(writes, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuth persistence never overwrites live credentials before the config commit succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-oauth-rollback-'));
  try {
    const configPath = join(dir, 'config.yaml');
    const originalConfig = 'providers: {}\ndefaults:\n  provider: log\n';
    await writeFile(configPath, originalConfig, { encoding: 'utf8', mode: 0o600 });
    const stored = new Map<string, string>([
      ['nightdrop/google-client-id', 'existing-client-id'],
      ['nightdrop/google-refresh-token', 'existing-refresh-token']
    ]);
    let writes = 0;
    const store = {
      set: async (key: string, value: string) => {
        stored.set(key, value);
        writes += 1;
        if (writes === 1) await chmod(configPath, 0o644);
      }
    };

    await assert.rejects(() => persistGmailOnboarding({
      configPath,
      store,
      clientId: 'replacement-client-id',
      refreshToken: 'replacement-refresh-token',
      email: 'replacement@gmail.com',
      setAsDefault: true
    }), /mode 0600/);

    assert.equal(stored.get('nightdrop/google-client-id'), 'existing-client-id');
    assert.equal(stored.get('nightdrop/google-refresh-token'), 'existing-refresh-token');
    assert.equal(await readFile(configPath, 'utf8'), originalConfig);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuth persistence rejects concurrent onboarding for the same config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-oauth-lock-'));
  let releaseFirstWrite!: () => void;
  let signalFirstWrite!: () => void;
  let first: Promise<void> | undefined;
  const firstWriteStarted = new Promise<void>((resolve) => { signalFirstWrite = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'providers: {}\ndefaults:\n  provider: log\n', { encoding: 'utf8', mode: 0o600 });
    first = persistGmailOnboarding({
      configPath,
      store: {
        set: async () => {
          signalFirstWrite();
          await release;
        }
      },
      clientId: 'first-client-id',
      refreshToken: 'first-refresh-token',
      email: 'first@gmail.com',
      setAsDefault: false
    });
    await firstWriteStarted;

    await assert.rejects(() => persistGmailOnboarding({
      configPath,
      store: { set: async () => undefined },
      clientId: 'second-client-id',
      refreshToken: 'second-refresh-token',
      email: 'second@gmail.com',
      setAsDefault: false
    }), /already in progress/);

    releaseFirstWrite();
    await first;
  } finally {
    releaseFirstWrite?.();
    await first?.catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test('Gmail persistence stores no temporary access token and writes only pass references', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-gmail-persist-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'providers: {}\ndefaults:\n  provider: log\n', { encoding: 'utf8', mode: 0o600 });
    const stored = new Map<string, string>();
    const store = { set: async (key: string, value: string) => { stored.set(key, value); } };

    await persistGmailOnboarding({
      configPath,
      store,
      clientId: 'google-client-id',
      refreshToken: 'long-lived-refresh-token',
      email: 'owner@gmail.com',
      displayName: 'Hash Bringer',
      setAsDefault: false
    });

    const keys = [...stored.keys()].sort();
    const suffix = assertVersionedCredentialKeys(keys, ['google-client-id', 'google-refresh-token']);
    assert(![...stored.values()].includes('temporary-access-token'));
    const parsed = YAML.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(parsed.providers.gmail.clientId, `\${PASS:nightdrop/google-client-id-${suffix}}`);
    assert.equal(parsed.providers.gmail.clientSecret, undefined);
    assert.equal(parsed.providers.gmail.refreshToken, `\${PASS:nightdrop/google-refresh-token-${suffix}}`);
    assert.equal(parsed.providers.gmail.fromAddress, 'owner@gmail.com');
    assert.equal(parsed.defaults.provider, 'log');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Outlook persistence stores a public-client refresh token without a client secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-outlook-persist-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'providers: {}\ndefaults:\n  provider: log\n', { encoding: 'utf8', mode: 0o600 });
    const stored = new Map<string, string>();
    const store = { set: async (key: string, value: string) => { stored.set(key, value); } };

    await persistOutlookOnboarding({
      configPath,
      store,
      clientId: 'microsoft-client-id',
      refreshToken: 'microsoft-refresh-token',
      tenantId: 'common',
      email: 'owner@outlook.com',
      displayName: 'Hash Bringer',
      setAsDefault: true
    });

    const keys = [...stored.keys()].sort();
    const suffix = assertVersionedCredentialKeys(keys, ['microsoft-client-id', 'microsoft-refresh-token']);
    const parsed = YAML.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(parsed.providers.outlook.clientId, `\${PASS:nightdrop/microsoft-client-id-${suffix}}`);
    assert.equal(parsed.providers.outlook.clientSecret, undefined);
    assert.equal(parsed.providers.outlook.refreshToken, `\${PASS:nightdrop/microsoft-refresh-token-${suffix}}`);
    assert.equal(parsed.providers.outlook.refreshTokenKey, `nightdrop/microsoft-refresh-token-${suffix}`);
    assert.equal(parsed.providers.outlook.tenantId, 'common');
    assert.equal(parsed.providers.outlook.fromAddress, 'owner@outlook.com');
    assert.equal(parsed.defaults.provider, 'outlook');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Outlook mailbox persistence writes a named provider and profile with mailbox access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-outlook-profile-persist-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'providers: {}\ndefaults:\n  provider: log\n', { encoding: 'utf8', mode: 0o600 });
    await persistOutlookOnboarding({
      configPath,
      store: { set: async () => undefined },
      clientId: 'microsoft-client-id',
      refreshToken: 'microsoft-refresh-token',
      tenantId: 'common',
      email: 'work@example.com',
      setAsDefault: false,
      providerName: 'outlook-work',
      mailboxProfileName: 'work',
      mailboxAccess: true
    });
    const parsed = YAML.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(parsed.providers['outlook-work'].mailboxAccess, true);
    assert.deepEqual(parsed.mailboxProfiles.work, { provider: 'outlook-work' });
    assert.equal(parsed.defaults.provider, 'log');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Zoho persistence stores credentials and pins the provider region', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nightdrop-zoho-persist-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'providers: {}\ndefaults:\n  provider: log\n', { encoding: 'utf8', mode: 0o600 });
    const stored = new Map<string, string>();
    const store = { set: async (key: string, value: string) => { stored.set(key, value); } };

    await persistZohoOnboarding({
      configPath,
      store,
      clientId: 'zoho-client-id',
      clientSecret: 'zoho-client-secret',
      refreshToken: 'zoho-refresh-token',
      region: 'eu',
      accountId: '123456789',
      email: 'owner@example.eu',
      displayName: 'Hash Bringer',
      setAsDefault: false
    });

    const keys = [...stored.keys()].sort();
    const suffix = assertVersionedCredentialKeys(keys, ['zoho-client-id', 'zoho-client-secret', 'zoho-refresh-token']);
    const parsed = YAML.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(parsed.providers.zoho.clientId, `\${PASS:nightdrop/zoho-client-id-${suffix}}`);
    assert.equal(parsed.providers.zoho.clientSecret, `\${PASS:nightdrop/zoho-client-secret-${suffix}}`);
    assert.equal(parsed.providers.zoho.refreshToken, `\${PASS:nightdrop/zoho-refresh-token-${suffix}}`);
    assert.equal(parsed.providers.zoho.region, 'eu');
    assert.equal(parsed.providers.zoho.accountId, '123456789');
    assert.equal(parsed.providers.zoho.fromAddress, 'owner@example.eu');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
