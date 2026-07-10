import { resolve4 } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { z } from 'zod';
import { buildGmailImapOptions } from '../mailbox/gmail-imap.js';
import type { MailboxUnsubscribeDraft } from '../schema.js';
import type { BrokerCredentials } from './gmail-inbox.js';
import { decodeInboxReference } from './reference.js';

const MAX_HEADER_BYTES = 16 * 1024;
const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click';
const EMAIL = z.string().email().max(320);

class SafeUnsubscribeError extends Error {}

interface UnsubscribeCommon {
  provider: 'gmail-smtp';
  account: string;
  sourcePath: 'INBOX';
  uidValidity: string;
  uid: number;
  from: string;
  subjectLine: string;
  receivedAt: string | null;
}

export type MailboxUnsubscribeSnapshot = UnsubscribeCommon & (
  | {
      method: 'rfc8058-https-post';
      endpointHost: string;
      endpointUrl: string;
    }
  | {
      method: 'rfc2369-mailto';
      recipient: string;
      subject: string;
      body: string;
    }
);

export type MailboxUnsubscribeResult =
  | { outcome: 'unsubscribe-accepted'; method: 'https' | 'mailto'; destination: string; details: string }
  | { outcome: 'unsubscribe-rejected'; method: 'https' | 'mailto'; destination: string; details: string }
  | { outcome: 'unsubscribe-ambiguous'; method: 'https' | 'mailto'; destination: string; details: string };

const cleanLine = (value: unknown, max = 500): string =>
  (typeof value === 'string' ? value : '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const displayAddress = (message: FetchMessageObject): string => {
  const first = message.envelope?.from?.[0];
  if (!first) return '[unknown sender]';
  const name = cleanLine(first.name, 200);
  const address = cleanLine(first.address, 320);
  return name && address ? `${name} <${address}>` : (address || name || '[unknown sender]');
};

const dateIso = (message: FetchMessageObject): string | null => {
  const date = message.envelope?.date ?? message.internalDate;
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const parseHeaderBlock = (raw: Buffer): Map<string, string[]> => {
  if (raw.length === 0 || raw.length > MAX_HEADER_BYTES) {
    throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
  }
  const unfolded = raw.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Map<string, string[]>();
  for (const line of unfolded.split(/\r?\n/)) {
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!/^[a-z0-9-]+$/.test(name) || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
      throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
    }
    headers.set(name, [...(headers.get(name) ?? []), value]);
  }
  return headers;
};

const singleHeader = (headers: Map<string, string[]>, name: string): string | null => {
  const values = headers.get(name);
  return values?.length === 1 ? values[0] : null;
};

const angleBracketUris = (value: string): string[] => {
  const uris: string[] = [];
  const remainder = value.replace(/<([^<>]+)>/g, (_match, uri: string) => {
    uris.push(uri.trim());
    return '';
  });
  if (uris.length === 0 || !/^[\s,]*$/.test(remainder) || uris.some((uri) => !uri)) {
    throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
  }
  return uris;
};

const strictHttpsUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    !hostname ||
    isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    !hostname.includes('.')
  ) {
    throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
  }
  return url;
};

const safeMailtoText = (value: string, max: number): string => {
  if (!value || value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
  }
  return value;
};

const strictMailto = (raw: string): { recipient: string; subject: string; body: string } => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
  }
  if (url.protocol !== 'mailto:' || url.hash || url.username || url.password || url.host) {
    throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
  }
  let recipient: string;
  try {
    recipient = decodeURIComponent(url.pathname);
  } catch {
    throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
  }
  if (!EMAIL.safeParse(recipient).success || /[,;]/.test(recipient)) {
    throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
  }
  const counts = new Map<string, number>();
  for (const [name] of url.searchParams) {
    if (name !== 'subject' && name !== 'body') {
      throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if ([...counts.values()].some((count) => count !== 1)) {
    throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
  }
  const subject = safeMailtoText(url.searchParams.get('subject') ?? 'unsubscribe', 500);
  const body = safeMailtoText(url.searchParams.get('body') ?? 'unsubscribe', 4096);
  return { recipient, subject, body };
};

const protocolOf = (raw: string): string => {
  try {
    return new URL(raw).protocol.toLowerCase();
  } catch {
    return '';
  }
};

export function selectUnsubscribeMethod(rawHeaders: Buffer):
  | { method: 'rfc8058-https-post'; endpointHost: string; endpointUrl: string }
  | { method: 'rfc2369-mailto'; recipient: string; subject: string; body: string } {
  const headers = parseHeaderBlock(rawHeaders);
  const listHeader = singleHeader(headers, 'list-unsubscribe');
  if (!listHeader) throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
  const uris = angleBracketUris(listHeader);
  const oneClick = singleHeader(headers, 'list-unsubscribe-post')?.toLowerCase() === 'list-unsubscribe=one-click';
  const httpsUris = uris.filter((uri) => protocolOf(uri) === 'https:');

  if (oneClick && httpsUris.length > 0) {
    if (httpsUris.length !== 1) throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
    const endpoint = strictHttpsUrl(httpsUris[0]);
    return {
      method: 'rfc8058-https-post',
      endpointHost: endpoint.hostname.toLowerCase(),
      endpointUrl: endpoint.toString()
    };
  }

  const mailtoUris = uris.filter((uri) => protocolOf(uri) === 'mailto:');
  if (mailtoUris.length !== 1) throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
  return { method: 'rfc2369-mailto', ...strictMailto(mailtoUris[0]) };
}

const isPublicIpv4 = (address: string): boolean => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
};

export class GmailUnsubscribeService {
  constructor(private readonly credentials: BrokerCredentials) {}

  private async withClient<T>(operation: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow(buildGmailImapOptions(this.credentials));
    client.on('error', () => {});
    try {
      await client.connect();
      return await operation(client);
    } catch (error) {
      if (error instanceof SafeUnsubscribeError) throw error;
      throw new Error('Gmail mailbox operation failed');
    } finally {
      try {
        if (client.usable) await client.logout();
        else client.close();
      } catch {
        client.close();
      }
    }
  }

  async prepare(draft: MailboxUnsubscribeDraft): Promise<MailboxUnsubscribeSnapshot> {
    if (draft.provider !== 'gmail-smtp') {
      throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
    }
    return this.prepareReference(draft.payload.ref);
  }

  async prepareReference(encodedReference: string): Promise<MailboxUnsubscribeSnapshot> {
    const reference = decodeInboxReference(encodedReference);
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true, acquireTimeout: 10_000 });
      try {
        if (!client.mailbox || client.mailbox.uidValidity.toString() !== reference.uidValidity) {
          throw new SafeUnsubscribeError('Message reference is stale');
        }
        const message = await client.fetchOne(
          reference.uid,
          {
            uid: true,
            envelope: true,
            internalDate: true,
            headers: ['list-unsubscribe', 'list-unsubscribe-post']
          },
          { uid: true }
        );
        if (!message || message.uid !== reference.uid) {
          throw new SafeUnsubscribeError('Message is no longer in INBOX');
        }
        if (!message.headers) {
          throw new SafeUnsubscribeError('Unsubscribe is unsupported for this message');
        }
        const selected = selectUnsubscribeMethod(message.headers);
        const common: UnsubscribeCommon = {
          provider: 'gmail-smtp',
          account: cleanLine(this.credentials.username, 320),
          sourcePath: 'INBOX',
          uidValidity: reference.uidValidity,
          uid: reference.uid,
          from: displayAddress(message),
          subjectLine: cleanLine(message.envelope?.subject, 500) || '[no subject]',
          receivedAt: dateIso(message)
        };
        return { ...common, ...selected };
      } finally {
        lock.release();
      }
    });
  }

  async executeHttps(snapshot: Extract<MailboxUnsubscribeSnapshot, { method: 'rfc8058-https-post' }>): Promise<MailboxUnsubscribeResult> {
    const endpoint = strictHttpsUrl(snapshot.endpointUrl);
    if (endpoint.hostname.toLowerCase() !== snapshot.endpointHost) {
      throw new Error('Approved unsubscribe destination changed');
    }

    let addresses: string[];
    try {
      addresses = await resolve4(snapshot.endpointHost);
    } catch {
      throw new Error('Unsubscribe destination could not be resolved');
    }
    if (addresses.length === 0 || addresses.some((address) => !isPublicIpv4(address))) {
      throw new Error('Unsubscribe destination is not a public HTTPS service');
    }
    const pinnedAddress = addresses[0];

    return new Promise((resolve) => {
      let settled = false;
      let requestStarted = false;
      const finish = (result: MailboxUnsubscribeResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        const request = httpsRequest({
          hostname: pinnedAddress,
          servername: snapshot.endpointHost,
          port: 443,
          path: `${endpoint.pathname}${endpoint.search}`,
          method: 'POST',
          rejectUnauthorized: true,
          headers: {
            Host: snapshot.endpointHost,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(ONE_CLICK_BODY),
            'User-Agent': 'agent-gate/0.1 unsubscribe'
          }
        }, (response) => {
          const status = response.statusCode ?? 0;
          response.destroy();
          if (status >= 200 && status < 300) {
            finish({
              outcome: 'unsubscribe-accepted',
              method: 'https',
              destination: snapshot.endpointHost,
              details: 'The standards-based HTTPS unsubscribe request was accepted'
            });
          } else {
            finish({
              outcome: 'unsubscribe-rejected',
              method: 'https',
              destination: snapshot.endpointHost,
              details: `The unsubscribe service rejected the request with HTTP ${status || 'unknown'}`
            });
          }
        });
        request.setTimeout(10_000, () => request.destroy(new Error('timeout')));
        request.once('error', () => {
          finish(requestStarted
            ? {
                outcome: 'unsubscribe-ambiguous',
                method: 'https',
                destination: snapshot.endpointHost,
                details: 'The HTTPS unsubscribe outcome could not be confirmed; do not retry automatically'
              }
            : {
                outcome: 'unsubscribe-rejected',
                method: 'https',
                destination: snapshot.endpointHost,
                details: 'The HTTPS unsubscribe request could not be started'
              });
        });
        requestStarted = true;
        request.end(ONE_CLICK_BODY);
      } catch {
        finish({
          outcome: 'unsubscribe-rejected',
          method: 'https',
          destination: snapshot.endpointHost,
          details: 'The HTTPS unsubscribe request could not be started'
        });
      }
    });
  }
}
