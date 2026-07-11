import { chmod, chown, lstat, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { MailboxAdapter } from './adapter.js';
import {
  MAILBOX_SOCKET_PATH,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MailboxRequestSchema,
  type MailboxRequest,
  type MailboxResponse
} from './protocol.js';
import { decodeInboxReference, decodeUniqueInboxReferences } from './reference.js';

const FALLBACK_ID = '00000000-0000-4000-8000-000000000000';
const SAFE_ERRORS = new Set([
  'Invalid message reference',
  'Message reference is stale',
  'Message is no longer in INBOX',
  'Message is too large to read through the mailbox broker',
  'Message could not be read safely',
  'One or more message references are stale',
  'One or more messages are no longer in INBOX',
  'Gmail mailbox operation failed',
  'Outlook mailbox operation failed',
  'Mailbox broker is busy',
  'Mailbox profile is required',
  'Mailbox profile is not configured',
  'Mailbox reference belongs to a different profile',
  'Mailbox references must belong to one profile',
  'Mailbox references must share one current INBOX identity',
  'Duplicate mailbox references are not allowed',
  'Trash proposal is unavailable',
  'Unsubscribe proposal is unavailable',
  'Unsubscribe is unsupported for this message'
]);

const responseLine = (response: MailboxResponse): string => {
  const line = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(line) > MAX_RESPONSE_BYTES) {
    return `${JSON.stringify({ v: 1, id: response.id, ok: false, error: 'Mailbox response exceeded the safe size limit' })}\n`;
  }
  return line;
};

export class MailboxBrokerServer {
  private server: Server | null = null;
  private activeOperations = 0;
  private readonly maxActiveOperations = 3;

  constructor(
    private readonly adapters: ReadonlyMap<string, MailboxAdapter>,
    private readonly socketPath: string,
    private readonly socketGroupGid: number,
    private readonly proposalWriter?: (profile: string, refs: readonly string[], context: string) => Promise<unknown>,
    private readonly unsubscribeProposalWriter?: (profile: string, ref: string, context: string) => Promise<unknown>
  ) {}

  private selectedProfile(requested?: string): string {
    if (requested) {
      if (!this.adapters.has(requested)) throw new Error('Mailbox profile is not configured');
      return requested;
    }
    if (this.adapters.size !== 1) throw new Error('Mailbox profile is required');
    return this.adapters.keys().next().value as string;
  }

  private legacyGmailProfile(): string {
    const matches = [...this.adapters.values()].filter((adapter) =>
      adapter.backend === 'gmail' && adapter.providerName === 'gmail-smtp'
    );
    if (matches.length !== 1) throw new Error('Mailbox profile is required');
    return matches[0].profile;
  }

  private profileFromReference(encodedReference: string): string {
    const reference = decodeInboxReference(encodedReference);
    const profile = reference.v === 2
      ? this.selectedProfile(reference.profile)
      : this.legacyGmailProfile();
    if (reference.v === 2 && this.adapter(profile).backend !== reference.backend) {
      throw new Error('Mailbox reference belongs to a different profile');
    }
    return profile;
  }

  private profileFromReferences(encodedReferences: readonly string[]): string {
    const references = decodeUniqueInboxReferences(encodedReferences);
    const first = references[0];
    if (!first) throw new Error('Invalid message reference');
    const profile = first.v === 2
      ? this.selectedProfile(first.profile)
      : this.legacyGmailProfile();
    if (first.v === 2 && this.adapter(profile).backend !== first.backend) {
      throw new Error('Mailbox reference belongs to a different profile');
    }
    return profile;
  }

  private adapter(profile: string): MailboxAdapter {
    const adapter = this.adapters.get(profile);
    if (!adapter) throw new Error('Mailbox profile is not configured');
    return adapter;
  }

  private async execute(request: MailboxRequest): Promise<unknown> {
    if (this.activeOperations >= this.maxActiveOperations) throw new Error('Mailbox broker is busy');
    this.activeOperations += 1;
    try {
      switch (request.op) {
        case 'profiles':
          return {
            profiles: [...this.adapters.values()].map((adapter) => ({
              name: adapter.profile,
              provider: adapter.providerName,
              providerType: adapter.backend,
              address: adapter.address
            }))
          };
        case 'list': {
          const profile = this.selectedProfile(request.profile);
          return await this.adapter(profile).list(request.unread, request.limit);
        }
        case 'read': {
          const profile = this.profileFromReference(request.ref);
          return await this.adapter(profile).read(request.ref);
        }
        case 'mark-read': {
          const profile = this.profileFromReferences(request.refs);
          return await this.adapter(profile).markRead(request.refs);
        }
        case 'propose-trash': {
          if (!this.proposalWriter) throw new Error('Trash proposal is unavailable');
          const profile = this.profileFromReferences(request.refs);
          return await this.proposalWriter(profile, request.refs, request.context);
        }
        case 'propose-unsubscribe': {
          if (!this.unsubscribeProposalWriter) throw new Error('Unsubscribe proposal is unavailable');
          const profile = this.profileFromReference(request.ref);
          return await this.unsubscribeProposalWriter(profile, request.ref, request.context);
        }
      }
    } finally {
      this.activeOperations -= 1;
    }
  }

  private handleSocket(socket: Socket): void {
    socket.setTimeout(90_000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let handled = false;

    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_BYTES) {
        handled = true;
        socket.end(responseLine({ v: 1, id: FALLBACK_ID, ok: false, error: 'Mailbox request rejected' }));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      socket.pause();
      const line = buffer.subarray(0, newline).toString('utf8');
      if (buffer.subarray(newline + 1).toString('utf8').trim()) {
        socket.end(responseLine({ v: 1, id: FALLBACK_ID, ok: false, error: 'Mailbox request rejected' }));
        return;
      }

      let request: MailboxRequest;
      try {
        request = MailboxRequestSchema.parse(JSON.parse(line));
      } catch {
        socket.end(responseLine({ v: 1, id: FALLBACK_ID, ok: false, error: 'Mailbox request rejected' }));
        return;
      }

      void this.execute(request)
        .then((result) => socket.end(responseLine({ v: 1, id: request.id, ok: true, result })))
        .catch((error: unknown) => {
          const message = error instanceof Error && SAFE_ERRORS.has(error.message)
            ? error.message
            : 'Mailbox operation failed';
          socket.end(responseLine({ v: 1, id: request.id, ok: false, error: message }));
        });
    });
    socket.on('error', () => socket.destroy());
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (this.socketPath !== MAILBOX_SOCKET_PATH || dirname(this.socketPath) === this.socketPath) {
      throw new Error('Invalid mailbox socket path');
    }
    try {
      const entry = await lstat(this.socketPath);
      if (!entry.isSocket() || entry.isSymbolicLink()) throw new Error('Unsafe mailbox socket path');
      await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const server = createServer((socket) => this.handleSocket(socket));
    this.server = server;
    const previousUmask = process.umask(0o007);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } finally {
      process.umask(previousUmask);
    }
    await chown(this.socketPath, process.getuid?.() ?? -1, this.socketGroupGid);
    await chmod(this.socketPath, 0o660);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
