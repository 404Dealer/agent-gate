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
  | { v: 1; id: string; op: 'mark-read'; refs: string[] };

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
  '',
  'Outputs JSON. Gmail credentials remain inside the isolated agent-gate service.'
].join('\n');

const validRef = (value: string): boolean => /^[A-Za-z0-9_-]{8,256}$/.test(value);

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
