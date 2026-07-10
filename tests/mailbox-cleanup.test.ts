import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseMailboxCleanupArgs } from '../src/mailbox/cli-options.js';
import { recordMailboxCleanupAudit } from '../src/mailbox/audit.js';
import { isCleanupConfirmed } from '../src/mailbox/confirmation.js';
import { loadGmailCleanupCredentials } from '../src/mailbox/config.js';
import {
  runMailboxCleanupCommand,
  type MailboxCleanupCommandDependencies,
  type ManagedCleanupConnection
} from '../src/mailbox-cleanup.js';
import {
  buildGmailImapOptions,
  GmailImapCleanupConnection,
  type GmailImapClient
} from '../src/mailbox/gmail-imap.js';
import {
  runMailboxCleanup,
  type CleanupMailboxConnection,
  type MailboxDescriptor,
  type MailboxUidSnapshot
} from '../src/mailbox/cleanup.js';

const execFile = promisify(execFileCallback);

test('mailbox cleanup CLI accepts only the fixed Gmail operation and non-secret config path', () => {
  assert.deepEqual(parseMailboxCleanupArgs(['gmail']), {
    provider: 'gmail',
    configPath: '/opt/agent-gate/config/config.yaml'
  });
  assert.deepEqual(parseMailboxCleanupArgs(['gmail', '--config', '/safe/config.yaml']), {
    provider: 'gmail',
    configPath: '/safe/config.yaml'
  });

  assert.throws(() => parseMailboxCleanupArgs([]), /Provider must be gmail/);
  assert.throws(() => parseMailboxCleanupArgs(['outlook']), /Provider must be gmail/);
  assert.throws(() => parseMailboxCleanupArgs(['gmail', '--config']), /requires a path/);
  assert.throws(() => parseMailboxCleanupArgs(['gmail', '--config', '/a', '--config', '/b']), /may be provided only once/);
  assert.throws(() => parseMailboxCleanupArgs(['gmail', '--password', 'secret']), /Unknown option/);
  assert.throws(() => parseMailboxCleanupArgs(['gmail', '--folder', 'INBOX']), /Unknown option/);
  assert.throws(() => parseMailboxCleanupArgs(['gmail', '--action', 'delete']), /Unknown option/);
});

test('mailbox cleanup requires the exact human confirmation phrase', () => {
  assert.equal(isCleanupConfirmed('MARK READ'), true);
  assert.equal(isCleanupConfirmed('  MARK READ  '), false);
  assert.equal(isCleanupConfirmed('mark read'), false);
  assert.equal(isCleanupConfirmed('yes'), false);
  assert.equal(isCleanupConfirmed('MARK READ NOW'), false);
});

test('mailbox cleanup marks only unread UIDs snapshotted before human confirmation', async () => {
  const mailboxes: MailboxDescriptor[] = [
    { path: '[Gmail]/Spam', flags: ['\\Junk'] },
    { path: '[Gmail]/Trash', flags: ['\\Trash'] },
    { path: 'INBOX', flags: [] }
  ];
  const snapshots = new Map<string, MailboxUidSnapshot>([
    ['[Gmail]/Spam', { uidValidity: '101', uids: [8, 3] }],
    ['[Gmail]/Trash', { uidValidity: '202', uids: [12] }]
  ]);
  const marked: Array<{ path: string; uidValidity: string; uids: number[] }> = [];
  const connection: CleanupMailboxConnection = {
    listMailboxes: async () => mailboxes,
    snapshotUnread: async (path) => snapshots.get(path)!,
    markSeen: async (_target, path, uidValidity, uids) => {
      marked.push({ path, uidValidity, uids: [...uids] });
      return uids.length;
    }
  };

  const result = await runMailboxCleanup(connection, async (preview) => {
    assert.equal(preview.spam.unreadCount, 2);
    assert.equal(preview.trash.unreadCount, 1);
    assert.equal(preview.totalUnread, 3);
    snapshots.get('[Gmail]/Spam')!.uids.push(99); // arrives after the approved snapshot
    return true;
  });

  assert.equal(result.outcome, 'applied');
  assert.equal(result.verifiedRead, 3);
  assert.deepEqual(marked, [
    { path: '[Gmail]/Spam', uidValidity: '101', uids: [3, 8] },
    { path: '[Gmail]/Trash', uidValidity: '202', uids: [12] }
  ]);
});

test('post-confirmation folder failure returns a partial outcome without reflecting server errors', async () => {
  const connection: CleanupMailboxConnection = {
    listMailboxes: async () => [
      { path: '[Gmail]/Spam', flags: ['\\Junk'] },
      { path: '[Gmail]/Trash', flags: ['\\Trash'] }
    ],
    snapshotUnread: async (path) => path.endsWith('Spam')
      ? { uidValidity: '101', uids: [3, 8] }
      : { uidValidity: '202', uids: [12] },
    markSeen: async (_target, path, _uidValidity, uids) => {
      if (path.endsWith('Trash')) throw new Error('remote secret diagnostic');
      return uids.length;
    }
  };

  const result = await runMailboxCleanup(connection, async () => true);

  assert.deepEqual(result, {
    outcome: 'partial',
    preview: {
      spam: { unreadCount: 2 },
      trash: { unreadCount: 1 },
      totalUnread: 3
    },
    verifiedRead: 2,
    incompleteFolders: ['trash']
  });
  assert.doesNotMatch(JSON.stringify(result), /remote secret diagnostic/);
});

test('mailbox cleanup trusts only unique raw server-declared special-use flags', async () => {
  let markCalls = 0;
  const snapshots = async (): Promise<MailboxUidSnapshot> => ({ uidValidity: '1', uids: [1] });
  const markSeen = async (): Promise<number> => { markCalls += 1; return 1; };

  await assert.rejects(
    () => runMailboxCleanup({
      listMailboxes: async () => [
        { path: '[Gmail]/Spam', flags: [], specialUse: '\\Junk' } as unknown as MailboxDescriptor,
        { path: '[Gmail]/Trash', flags: ['\\Trash'] } as unknown as MailboxDescriptor
      ],
      snapshotUnread: snapshots,
      markSeen
    }, async () => true),
    /spam special-use mailbox is missing or ambiguous/
  );

  await assert.rejects(
    () => runMailboxCleanup({
      listMailboxes: async () => [
        { path: '[Gmail]/Spam', flags: ['\\Junk'], specialUse: '\\Junk' } as unknown as MailboxDescriptor,
        { path: 'Other Spam', flags: ['\\Junk'] } as unknown as MailboxDescriptor,
        { path: '[Gmail]/Trash', flags: ['\\Trash'] } as unknown as MailboxDescriptor
      ],
      snapshotUnread: snapshots,
      markSeen
    }, async () => true),
    /spam special-use mailbox is missing or ambiguous/
  );
  assert.equal(markCalls, 0);
});

test('mailbox cleanup revalidates each authoritative role and path before mutation', async () => {
  let listCalls = 0;
  let markCalls = 0;
  const connection: CleanupMailboxConnection = {
    listMailboxes: async () => {
      listCalls += 1;
      return listCalls === 1
        ? [
            { path: '[Gmail]/Spam', flags: ['\\Junk'] } as unknown as MailboxDescriptor,
            { path: '[Gmail]/Trash', flags: ['\\Trash'] } as unknown as MailboxDescriptor
          ]
        : [
            { path: 'Reassigned Spam', flags: ['\\Junk'] } as unknown as MailboxDescriptor,
            { path: '[Gmail]/Trash', flags: ['\\Trash'] } as unknown as MailboxDescriptor
          ];
    },
    snapshotUnread: async (path) => ({
      uidValidity: path.endsWith('Spam') ? '101' : '202',
      uids: path.endsWith('Spam') ? [3] : []
    }),
    markSeen: async () => { markCalls += 1; return 1; }
  };

  const result = await runMailboxCleanup(connection, async () => true);
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.incompleteFolders, ['spam']);
  assert.equal(result.verifiedRead, 0);
  assert.equal(markCalls, 0);
  assert.ok(listCalls >= 2);
});

test('Gmail IMAP adapter rejects SEARCH failure and installs a redacting error listener', async () => {
  let errorListener: ((error: Error) => void) | undefined;
  const client = {
    mailbox: false as false | { uidValidity: bigint },
    on: (event: string, listener: (error: Error) => void) => {
      if (event === 'error') errorListener = listener;
      return client;
    },
    connect: async () => undefined,
    list: async () => [],
    getMailboxLock: async () => {
      client.mailbox = { uidValidity: 1n };
      return { path: '[Gmail]/Spam', release: () => undefined };
    },
    search: async () => false as false,
    messageFlagsAdd: async () => true,
    logout: async () => undefined,
    close: () => undefined
  } as GmailImapClient;
  const connection = new GmailImapCleanupConnection(
    { username: 'owner@gmail.com', password: 'abcdefghijklmnop' },
    () => client
  );

  assert.equal(typeof errorListener, 'function');
  await assert.rejects(() => connection.snapshotUnread('[Gmail]/Spam'), /Gmail IMAP operation failed/);
  errorListener?.(new Error('remote secret diagnostic'));
  await assert.rejects(() => connection.listMailboxes(), /Gmail IMAP operation failed/);
});

test('Gmail IMAP adapter verifies the approved UID set after STORE', async () => {
  let searchCall = 0;
  const client = {
    mailbox: false as false | { uidValidity: bigint },
    on: () => client,
    connect: async () => undefined,
    list: async () => [
      { path: '[Gmail]/Spam', flags: new Set(['\\Junk']) },
      { path: '[Gmail]/Trash', flags: new Set(['\\Trash']) }
    ],
    getMailboxLock: async (path: string) => {
      client.mailbox = { uidValidity: path.endsWith('Spam') ? 101n : 202n };
      return { path, release: () => undefined };
    },
    search: async () => {
      searchCall += 1;
      return [5];
    },
    messageFlagsAdd: async () => true,
    logout: async () => undefined,
    close: () => undefined
  } as GmailImapClient;
  const connection = new GmailImapCleanupConnection(
    { username: 'owner@gmail.com', password: 'abcdefghijklmnop' },
    () => client
  );

  assert.equal(await connection.markSeen('trash', '[Gmail]/Trash', '202', [5, 9]), 1);
  assert.equal(searchCall, 1);
});

test('Gmail cleanup credentials use the absolute pass pin instead of PATH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-mailbox-config-'));
  try {
    const configPath = join(dir, 'config.yaml');
    const pathDir = join(dir, 'path');
    const pinnedPass = join(dir, 'pinned-pass');
    const pathPass = join(pathDir, 'pass');
    const selectionPath = join(dir, 'selection.txt');
    const argsPath = join(dir, 'args.txt');
    await mkdir(pathDir);
    await writeFile(configPath, `
providers:
  gmail-smtp:
    type: email-smtp
    host: smtp.gmail.com
    port: 465
    tlsMode: implicit
    username: owner@gmail.com
    password: "\${PASS:agent-gate/smtp-password-0123456789abcdef01234567}"
    fromAddress: owner@gmail.com
`, { encoding: 'utf8', mode: 0o600 });
    await writeFile(
      pinnedPass,
      '#!/bin/sh\nprintf pinned > "$FAKE_PASS_SELECTION"\nprintf "%s\\n" "$@" > "$FAKE_PASS_ARGS"\nprintf abcdefghijklmnop\n',
      'utf8'
    );
    await writeFile(
      pathPass,
      '#!/bin/sh\nprintf path-search > "$FAKE_PASS_SELECTION"\nprintf abcdefghijklmnop\n',
      'utf8'
    );
    await chmod(pinnedPass, 0o700);
    await chmod(pathPass, 0o700);

    const credentials = await loadGmailCleanupCredentials(configPath, {
      AGENT_GATE_PASS_BIN: pinnedPass,
      PATH: pathDir,
      FAKE_PASS_SELECTION: selectionPath,
      FAKE_PASS_ARGS: argsPath
    });

    assert.deepEqual(credentials, {
      username: 'owner@gmail.com',
      password: 'abcdefghijklmnop'
    });
    assert.equal(await readFile(selectionPath, 'utf8'), 'pinned');
    const args = await readFile(argsPath, 'utf8');
    assert.equal(args, 'show\nagent-gate/smtp-password-0123456789abcdef01234567\n');
    assert.doesNotMatch(args, /abcdefghijklmnop/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Gmail IMAP options enforce verified TLS, fixed endpoints, bounds, and no logging', () => {
  assert.deepEqual(buildGmailImapOptions({
    username: 'owner@gmail.com',
    password: 'abcdefghijklmnop'
  }), {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    servername: 'imap.gmail.com',
    auth: { user: 'owner@gmail.com', pass: 'abcdefghijklmnop' },
    tls: {
      servername: 'imap.gmail.com',
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2'
    },
    disableAutoIdle: true,
    disableCompression: true,
    logger: false,
    logRaw: false,
    emitLogs: false,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 30_000,
    maxLineLength: 1_048_576,
    maxLiteralSize: 1_048_576,
    maxLockHoldTime: 15_000
  });
});

test('Gmail IMAP adapter uses UID locks and rejects mailbox identity changes before mutation', async () => {
  const events: unknown[] = [];
  let clientOptions: unknown;
  const client: GmailImapClient = {
    mailbox: false,
    on: (_event, _listener) => client,
    connect: async () => { events.push('connect'); },
    list: async () => [
      { path: '[Gmail]/Spam', flags: new Set(['\\Junk']) },
      { path: '[Gmail]/Trash', flags: new Set(['\\Trash']) }
    ],
    getMailboxLock: async (path, options) => {
      events.push(['lock', path, options]);
      client.mailbox = { uidValidity: path.endsWith('Spam') ? 101n : 202n };
      return { path, release: () => { events.push(['release', path]); } };
    },
    search: async (query, options) => {
      events.push(['search', query, options]);
      return [9, 5];
    },
    messageFlagsAdd: async (uids, flags, options) => {
      events.push(['flags', uids, flags, options]);
      return true;
    },
    logout: async () => { events.push('logout'); },
    close: () => { events.push('close'); }
  };
  const connection = new GmailImapCleanupConnection(
    { username: 'owner@gmail.com', password: 'abcdefghijklmnop' },
    (options) => {
      clientOptions = options;
      return client;
    }
  );

  await connection.connect();
  assert.deepEqual(await connection.listMailboxes(), [
    { path: '[Gmail]/Spam', flags: ['\\Junk'] },
    { path: '[Gmail]/Trash', flags: ['\\Trash'] }
  ]);
  assert.deepEqual(await connection.snapshotUnread('[Gmail]/Spam'), {
    uidValidity: '101',
    uids: [9, 5]
  });
  assert.equal(await connection.markSeen('trash', '[Gmail]/Trash', '202', [5, 9]), 2);
  await assert.rejects(
    () => connection.markSeen('trash', '[Gmail]/Trash', '999', [5]),
    /Gmail IMAP operation failed/
  );
  await connection.disconnect();

  assert.deepEqual(clientOptions, buildGmailImapOptions({
    username: 'owner@gmail.com',
    password: 'abcdefghijklmnop'
  }));
  assert.deepEqual(events.filter((event) => Array.isArray(event) && event[0] === 'search'), [
    ['search', { seen: false }, { uid: true }],
    ['search', { seen: true, uid: '5,9' }, { uid: true }]
  ]);
  assert.deepEqual(events.filter((event) => Array.isArray(event) && event[0] === 'flags'), [
    ['flags', [5, 9], ['\\Seen'], { uid: true }]
  ]);
  assert.equal(events.filter((event) => Array.isArray(event) && event[0] === 'release').length, 3);
  assert.equal(events.at(-1), 'logout');
});

test('mailbox cleanup command prints only counts and clears its local credential reference', async () => {
  const output: string[] = [];
  const events: string[] = [];
  const auditEvents: unknown[] = [];
  let active = false;
  let connectionCount = 0;
  const credentials = { username: 'owner@gmail.com', password: 'abcdefghijklmnop' };
  const connection: CleanupMailboxConnection & { connect(): Promise<void>; disconnect(): Promise<void> } = {
    connect: async () => { active = true; events.push('connect'); },
    disconnect: async () => { active = false; events.push('disconnect'); },
    listMailboxes: async () => [
      { path: '[Gmail]/Spam', flags: ['\\Junk'] },
      { path: '[Gmail]/Trash', flags: ['\\Trash'] }
    ],
    snapshotUnread: async (path) => path.endsWith('Spam')
      ? { uidValidity: '101', uids: [3, 8] }
      : { uidValidity: '202', uids: [12] },
    markSeen: async (_target, _path, _uidValidity, uids) => uids.length
  };
  const dependencies: MailboxCleanupCommandDependencies = {
    loadCredentials: async () => credentials,
    createConnection: () => {
      connectionCount += 1;
      return connection;
    },
    prompt: async (question) => {
      assert.equal(active, false);
      output.push(question);
      return 'MARK READ';
    },
    recordAudit: async (event) => { auditEvents.push(event); },
    write: (message) => { output.push(message); }
  };

  const result = await runMailboxCleanupCommand({
    provider: 'gmail',
    configPath: '/private/config.yaml'
  }, dependencies);

  assert.equal(result.outcome, 'applied');
  assert.equal(result.verifiedRead, 3);
  assert.equal(connectionCount, 2);
  assert.deepEqual(events, ['connect', 'disconnect', 'connect', 'disconnect']);
  assert.equal(credentials.password, '');
  assert.deepEqual(auditEvents, [{
    action: 'mailbox-cleanup',
    provider: 'gmail-smtp',
    outcome: 'applied',
    snapshotTotal: 3,
    verifiedRead: 3,
    incompleteFolders: []
  }]);
  assert.doesNotMatch(JSON.stringify(auditEvents), /abcdefghijklmnop/);
  const transcript = output.join('\n');
  assert.match(transcript, /Gmail mailbox: owner@gmail\.com/);
  assert.match(transcript, /Unread Spam: 2/);
  assert.match(transcript, /Unread Trash: 1/);
  assert.match(transcript, /Type MARK READ/);
  assert.match(transcript, /Verified 3 messages are read/);
  assert.doesNotMatch(transcript, /abcdefghijklmnop/);
});

test('post-mutation disconnect, audit, and terminal failures do not relabel a completed cleanup', async () => {
  let mutationCompleted = false;
  let auditCalls = 0;
  let connectionCount = 0;
  const credentials = { username: 'owner@gmail.com', password: 'abcdefghijklmnop' };
  const connection: ManagedCleanupConnection = {
    connect: async () => undefined,
    disconnect: async () => {
      if (mutationCompleted) throw new Error('raw disconnect diagnostic');
    },
    listMailboxes: async () => [
      { path: '[Gmail]/Spam', flags: ['\\Junk'] },
      { path: '[Gmail]/Trash', flags: ['\\Trash'] }
    ],
    snapshotUnread: async (path) => ({
      uidValidity: path.endsWith('Spam') ? '101' : '202',
      uids: path.endsWith('Spam') ? [3] : []
    }),
    markSeen: async (_target, _path, _uidValidity, uids) => {
      mutationCompleted = true;
      return uids.length;
    }
  };

  const result = await runMailboxCleanupCommand({
    provider: 'gmail',
    configPath: '/private/config.yaml'
  }, {
    loadCredentials: async () => credentials,
    createConnection: () => {
      connectionCount += 1;
      return connection;
    },
    prompt: async () => 'MARK READ',
    recordAudit: async () => {
      auditCalls += 1;
      throw new Error('raw audit diagnostic');
    },
    write: (message) => {
      if (message.startsWith('WARNING:') || message.startsWith('Marked ')) {
        throw new Error('terminal unavailable');
      }
    }
  });

  assert.equal(result.outcome, 'applied');
  assert.equal(result.verifiedRead, 1);
  assert.equal(mutationCompleted, true);
  assert.equal(connectionCount, 2);
  assert.equal(auditCalls, 1);
  assert.equal(credentials.password, '');
});

test('production mailbox cleanup wrapper preserves the credential boundary and fixed operation', async () => {
  const wrapper = await readFile(new URL('../scripts/mailbox-cleanup.sh', import.meta.url), 'utf8');
  assert.match(wrapper, /^#!\/bin\/bash$/m);
  assert.match(wrapper, /if \[\[ \$EUID -ne 0 \]\]/);
  assert.match(wrapper, /if \[\[ ! -t 0 \|\| ! -t 1 \]\]/);
  assert.match(wrapper, /readonly TRUSTED_PATH=/);
  assert.match(wrapper, /validate_trusted_path/);
  assert.match(wrapper, /assert_trusted_ancestor_chain/);
  assert.match(wrapper, /resolve_trusted_executable node/);
  assert.match(wrapper, /resolve_trusted_executable runuser/);
  assert.match(wrapper, /resolve_trusted_executable env/);
  assert.match(wrapper, /resolve_trusted_executable pass/);
  assert.match(wrapper, /AGENT_GATE_PASS_BIN="\$PASS_BIN"/);
  assert.match(wrapper, /AGENT_GATE_AUDIT_LOG="\$INSTALL_DIR\/audit\.log"/);
  assert.match(wrapper, /"\$RUNUSER_BIN" -u "\$SERVICE_USER" -- "\$ENV_BIN" -i/);
  assert.match(wrapper, /dist\/mailbox-cleanup\.js/);
  assert.match(wrapper, /"gmail" --config "\$CONFIG_PATH"/);
  assert.doesNotMatch(wrapper, /systemctl|--password|--folder|--action|"\$@"/);

  const installer = await readFile(new URL('../scripts/install-production.sh', import.meta.url), 'utf8');
  assert.match(installer, /"\$INSTALL_DIR\/scripts\/mailbox-cleanup\.sh"/);
});

test('mailbox cleanup help cannot execute an attacker-provided PATH command before validation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-mailbox-wrapper-'));
  try {
    const binDir = join(dir, 'bin');
    const copiedWrapper = join(dir, 'mailbox-cleanup.sh');
    const marker = join(dir, 'attacker-ran');
    await mkdir(binDir);
    await writeFile(
      join(binDir, 'cat'),
      '#!/bin/sh\nprintf exploited > "$ATTACK_MARKER"\n',
      { encoding: 'utf8', mode: 0o755 }
    );
    const source = await readFile(new URL('../scripts/mailbox-cleanup.sh', import.meta.url), 'utf8');
    await writeFile(
      copiedWrapper,
      source.replace(
        "readonly TRUSTED_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'",
        `readonly TRUSTED_PATH='${binDir}'`
      ),
      { encoding: 'utf8', mode: 0o755 }
    );

    const { stdout } = await execFile('/bin/bash', [copiedWrapper, '--help'], {
      env: { ...process.env, ATTACK_MARKER: marker }
    });
    assert.match(stdout, /Usage: sudo .*mailbox-cleanup\.sh gmail/);
    await assert.rejects(() => readFile(marker, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mailbox cleanup audit appends counts-only JSONL and rejects symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-mailbox-audit-'));
  try {
    const auditPath = join(dir, 'audit.log');
    const redirectedPath = join(dir, 'redirected.log');
    const symlinkPath = join(dir, 'audit-link.log');
    await writeFile(auditPath, '', { encoding: 'utf8', mode: 0o640 });
    await chmod(auditPath, 0o640);
    const event = {
      action: 'mailbox-cleanup' as const,
      provider: 'gmail-smtp' as const,
      outcome: 'applied' as const,
      snapshotTotal: 3,
      verifiedRead: 3,
      incompleteFolders: []
    };

    await recordMailboxCleanupAudit(auditPath, event);
    const parsed = JSON.parse((await readFile(auditPath, 'utf8')).trim()) as Record<string, unknown>;
    assert.match(String(parsed.ts), /^\d{4}-\d{2}-\d{2}T/);
    delete parsed.ts;
    assert.deepEqual(parsed, event);
    assert.doesNotMatch(JSON.stringify(parsed), /password|subject|body/i);

    await writeFile(redirectedPath, 'sentinel', { encoding: 'utf8', mode: 0o640 });
    await symlink(redirectedPath, symlinkPath);
    await assert.rejects(
      () => recordMailboxCleanupAudit(symlinkPath, event),
      /audit persistence failed/
    );
    assert.equal(await readFile(redirectedPath, 'utf8'), 'sentinel');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mailbox cleanup skips confirmation for no-op and performs no writes when cancelled', async () => {
  let confirmCalls = 0;
  let markCalls = 0;
  const baseConnection = {
    listMailboxes: async () => [
      { path: '[Gmail]/Spam', flags: ['\\Junk'] },
      { path: '[Gmail]/Trash', flags: ['\\Trash'] }
    ],
    markSeen: async () => { markCalls += 1; return 0; }
  };

  const noOp = await runMailboxCleanup({
    ...baseConnection,
    snapshotUnread: async () => ({ uidValidity: '1', uids: [] })
  }, async () => { confirmCalls += 1; return true; });
  assert.equal(noOp.outcome, 'no-op');
  assert.equal(confirmCalls, 0);
  assert.equal(markCalls, 0);

  const cancelled = await runMailboxCleanup({
    ...baseConnection,
    snapshotUnread: async (path) => ({
      uidValidity: path.endsWith('Spam') ? '1' : '2',
      uids: [1]
    })
  }, async () => { confirmCalls += 1; return false; });
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(confirmCalls, 1);
  assert.equal(markCalls, 0);
});

test('mailbox cleanup rejects ineligible Gmail config before reading pass', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-mailbox-invalid-config-'));
  try {
    const configPath = join(dir, 'config.yaml');
    const markerPath = join(dir, 'pass-invoked');
    const passPath = join(dir, 'pass');
    await writeFile(passPath, `#!/bin/sh\nprintf invoked > "${markerPath}"\nprintf abcdefghijklmnop\\n\n`, { encoding: 'utf8', mode: 0o755 });
    await chmod(passPath, 0o755);
    await writeFile(configPath, `providers:\n  gmail-smtp:\n    type: email-smtp\n    host: smtp.gmail.com\n    port: 465\n    tlsMode: implicit\n    username: owner@gmail.com\n    password: exposed-inline-secret\n    fromAddress: owner@gmail.com\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(configPath, 0o600);

    await assert.rejects(
      () => loadGmailCleanupCredentials(configPath, { AGENT_GATE_PASS_BIN: passPath }),
      /must remain an isolated pass reference/
    );
    await assert.rejects(() => readFile(markerPath, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
