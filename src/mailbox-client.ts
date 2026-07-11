#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';

const SOCKET_PATH = '/run/agent-gate-mailbox/broker.sock';
const MAX_RESPONSE_BYTES = 1024 * 1024;

type ClientRequest =
  | { v: 1; id: string; op: 'list'; unread: boolean; limit: number }
  | { v: 1; id: string; op: 'read'; ref: string }
  | { v: 1; id: string; op: 'mark-read'; refs: string[] }
  | { v: 1; id: string; op: 'propose-trash'; refs: string[]; context: string }
  | { v: 1; id: string; op: 'propose-unsubscribe'; ref: string; context: string };

interface ClientResponse {
  v: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const usage = (): string => [
  'Usage:',
  '  agent-gate-mailbox list [--unread] [--limit 1-50]',
  '  agent-gate-mailbox read MESSAGE_REF',
  '  agent-gate-mailbox mark-read MESSAGE_REF [MESSAGE_REF ...]',
  '  agent-gate-mailbox propose-trash MESSAGE_REF [MESSAGE_REF ...] [--context TEXT]',
  '  agent-gate-mailbox propose-unsubscribe MESSAGE_REF [--context TEXT]',
  '',
  'Outputs JSON. Gmail credentials remain inside the isolated agent-gate service.'
].join('\n');

const refIdentity = (value: string): { uidValidity: string; uid: number } | null => {
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(value)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort().join(',');
    if (keys !== 'folder,uid,uidValidity,v' || parsed.v !== 1 || parsed.folder !== 'inbox' ||
        typeof parsed.uidValidity !== 'string' || !/^[1-9][0-9]*$/.test(parsed.uidValidity) ||
        typeof parsed.uid !== 'number' || !Number.isSafeInteger(parsed.uid) || parsed.uid < 1) return null;
    const canonical = Buffer.from(JSON.stringify({
      v: 1,
      folder: 'inbox',
      uidValidity: parsed.uidValidity,
      uid: parsed.uid
    }), 'utf8').toString('base64url');
    return canonical === value ? { uidValidity: parsed.uidValidity, uid: parsed.uid } : null;
  } catch {
    return null;
  }
};

const validRef = (value: string): boolean => refIdentity(value) !== null;

export function parseMailboxClientArgs(argv: string[]): ClientRequest | 'help' {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return 'help';
  const id = randomUUID();
  const command = argv[0];
  if (command === 'list') {
    let unread = false;
    let limit = 20;
    for (let index = 1; index < argv.length; index += 1) {
      if (argv[index] === '--unread') {
        unread = true;
      } else if (argv[index] === '--limit' && index + 1 < argv.length) {
        const value = argv[index + 1];
        if (!/^[0-9]+$/.test(value)) throw new Error('Invalid mailbox command');
        limit = Number(value);
        index += 1;
      } else {
        throw new Error('Invalid mailbox command');
      }
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid mailbox command');
    return { v: 1, id, op: 'list', unread, limit };
  }
  if (command === 'read' && argv.length === 2 && validRef(argv[1])) {
    return { v: 1, id, op: 'read', ref: argv[1] };
  }
  if (command === 'mark-read' && argv.length >= 2 && argv.length <= 21 && argv.slice(1).every(validRef)) {
    return { v: 1, id, op: 'mark-read', refs: argv.slice(1) };
  }
  if (command === 'propose-trash') {
    const contextIndex = argv.indexOf('--context');
    const hasContext = contextIndex >= 0;
    if (hasContext && (contextIndex < 2 || contextIndex + 2 !== argv.length)) throw new Error('Invalid mailbox command');
    const refs = argv.slice(1, hasContext ? contextIndex : argv.length);
    const context = hasContext ? argv[contextIndex + 1] : 'User requested these exact INBOX messages be moved to Trash';
    const decoded = refs.map(refIdentity);
    const firstUidValidity = decoded[0]?.uidValidity;
    const semanticIdentities = decoded.map((ref) => ref ? `${ref.uidValidity}:${ref.uid}` : 'invalid');
    if (refs.length < 1 || refs.length > 20 || decoded.some((ref) => !ref) || !firstUidValidity ||
        decoded.some((ref) => ref?.uidValidity !== firstUidValidity) ||
        new Set(semanticIdentities).size !== refs.length || context.length > 1000) {
      throw new Error('Invalid mailbox command');
    }
    return { v: 1, id, op: 'propose-trash', refs, context };
  }
  if (command === 'propose-unsubscribe') {
    const contextIndex = argv.indexOf('--context');
    const hasContext = contextIndex >= 0;
    if (hasContext && (contextIndex !== 2 || contextIndex + 2 !== argv.length)) {
      throw new Error('Invalid mailbox command');
    }
    const ref = argv[1];
    const context = hasContext
      ? argv[contextIndex + 1]
      : 'User requested a standards-based unsubscribe for this exact INBOX message';
    if ((!hasContext && argv.length !== 2) || !ref || !validRef(ref) || context.length > 1000) {
      throw new Error('Invalid mailbox command');
    }
    return { v: 1, id, op: 'propose-unsubscribe', ref, context };
  }
  throw new Error('Invalid mailbox command');
}

const validResponse = (value: unknown, requestId: string): value is ClientResponse => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (entry.v !== 1 || entry.id !== requestId || typeof entry.ok !== 'boolean') return false;
  if (entry.ok) return Object.hasOwn(entry, 'result');
  return typeof entry.error === 'string' && entry.error.length >= 1 && entry.error.length <= 200;
};

async function callBroker(request: ClientRequest): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(SOCKET_PATH);
    let settled = false;
    let response = Buffer.alloc(0);
    const fail = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('Mailbox broker unavailable'));
    };
    socket.setTimeout(90_000, fail);
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_RESPONSE_BYTES) fail();
    });
    socket.once('error', fail);
    socket.once('end', () => {
      if (settled) return;
      settled = true;
      try {
        const parsed: unknown = JSON.parse(response.toString('utf8'));
        if (!validResponse(parsed, request.id)) throw new Error('invalid');
        resolve(parsed);
      } catch {
        reject(new Error('Mailbox broker returned an invalid response'));
      }
    });
  });
}

export async function runMailboxClient(argv = process.argv.slice(2)): Promise<number> {
  let request: ClientRequest | 'help';
  try {
    request = parseMailboxClientArgs(argv);
  } catch {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  if (request === 'help') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    const response = await callBroker(request);
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return response.ok ? 0 : 1;
  } catch {
    process.stderr.write('Mailbox broker unavailable\n');
    return 1;
  }
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runMailboxClient();
}
