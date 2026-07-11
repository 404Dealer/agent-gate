import { z } from 'zod';
import type { ProviderConfig } from '../config.js';
import type { MailboxTrashDraft, MailboxUnsubscribeDraft } from '../schema.js';
import type { MailboxAdapter, MailboxMarkReadResult } from './adapter.js';
import type { InboxListItem, InboxListResult, InboxMessage } from './gmail-inbox.js';
import type {
  MailboxTrashResult,
  MailboxTrashSnapshot,
  OutlookMailboxTrashSnapshot
} from './gmail-trash.js';
import {
  executeHttpsUnsubscribe,
  selectUnsubscribeMethod,
  type MailboxUnsubscribeResult,
  type MailboxUnsubscribeSnapshot
} from './gmail-unsubscribe.js';
import {
  decodeInboxReference,
  decodeUniqueInboxReferences,
  encodeOutlookInboxReference,
  type OutlookInboxReference
} from './reference.js';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const MAX_GRAPH_RESPONSE_BYTES = 1024 * 1024;
const OUTLOOK_LIST_SCAN_LIMIT = 200;
const MAX_BODY_BYTES = 256 * 1024;

export interface OutlookGraphClient {
  request(url: string, init?: RequestInit): Promise<Response>;
}

const EmailAddressSchema = z.object({
  name: z.string().optional(),
  address: z.string().optional()
}).strict();
const RecipientSchema = z.object({ emailAddress: EmailAddressSchema }).strict();
const MessagePreviewSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9+\/_=-]{1,2048}$/),
  from: RecipientSchema.nullish(),
  subject: z.string().nullish(),
  receivedDateTime: z.string().nullish()
}).passthrough();
const MessageSummarySchema = MessagePreviewSchema.extend({
  isRead: z.boolean(),
  flag: z.object({ flagStatus: z.string().optional() }).passthrough().optional(),
  toRecipients: z.array(RecipientSchema).optional(),
  ccRecipients: z.array(RecipientSchema).optional(),
  hasAttachments: z.boolean().optional(),
  body: z.object({ contentType: z.string(), content: z.string() }).strict().optional()
});
const ListResponseSchema = z.object({
  value: z.array(MessageSummarySchema),
  '@odata.nextLink': z.string().optional()
}).passthrough();
const AttachmentsResponseSchema = z.object({
  value: z.array(z.object({
    name: z.string().nullish(),
    contentType: z.string().nullish(),
    size: z.number().int().nonnegative().nullish()
  }).passthrough()).max(50)
}).passthrough();
const HeaderMessageSchema = MessagePreviewSchema.extend({
  internetMessageHeaders: z.array(z.object({
    name: z.string().min(1).max(200),
    value: z.string().max(16 * 1024).refine((value) => !/[\r\n]/.test(value), 'invalid header value')
  }).strict()).max(200)
});

const cleanLine = (value: unknown, max = 500): string =>
  (typeof value === 'string' ? value : '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const cleanBody = (value: unknown): string => {
  const body = (typeof value === 'string' ? value : '').replace(/\u0000/g, '');
  const encoded = Buffer.from(body, 'utf8');
  return encoded.length <= MAX_BODY_BYTES ? body : encoded.subarray(0, MAX_BODY_BYTES).toString('utf8');
};

const address = (recipient: z.infer<typeof RecipientSchema> | null | undefined): string => {
  const name = cleanLine(recipient?.emailAddress.name, 200);
  const email = cleanLine(recipient?.emailAddress.address, 320);
  return name && email ? `${name} <${email}>` : (email || name);
};

const addresses = (recipients: z.infer<typeof RecipientSchema>[] | undefined): string[] =>
  (recipients ?? []).slice(0, 50).map(address).filter(Boolean);

async function readJsonLimited(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_GRAPH_RESPONSE_BYTES) {
    throw new Error('Outlook mailbox response exceeded the safe size limit');
  }
  if (!response.body) throw new Error('Outlook mailbox returned an empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_GRAPH_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Outlook mailbox response exceeded the safe size limit');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
  } catch (error) {
    if (error instanceof Error && /safe size limit/.test(error.message)) throw error;
    throw new Error('Outlook mailbox returned invalid JSON');
  }
}

export class OutlookMailboxAdapter implements MailboxAdapter {
  readonly backend = 'outlook' as const;
  readonly address: string;
  private readonly basePath: string;

  constructor(
    readonly profile: string,
    readonly providerName: string,
    private readonly providerConfig: Extract<ProviderConfig, { type: 'email-outlook' }>,
    private readonly graph: OutlookGraphClient
  ) {
    if (providerConfig.mailboxAccess !== true) throw new Error('Outlook mailbox access is not authorized');
    this.address = providerConfig.fromAddress;
    this.basePath = providerConfig.userId
      ? `/v1.0/users/${encodeURIComponent(providerConfig.userId)}`
      : '/v1.0/me';
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { Prefer: 'IdType="ImmutableId"', ...extra };
  }

  private async json(url: string, init?: RequestInit): Promise<unknown> {
    const response = await this.graph.request(url, init);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Outlook mailbox operation failed');
    }
    return readJsonLimited(response);
  }

  private messageReference(encoded: string): OutlookInboxReference {
    const reference = decodeInboxReference(encoded);
    if (reference.v !== 2 || reference.backend !== 'outlook' || reference.profile !== this.profile) {
      throw new Error('Mailbox reference belongs to a different profile');
    }
    return reference;
  }

  private messageUrl(messageId: string): string {
    return `${GRAPH_ORIGIN}${this.basePath}/mailFolders/inbox/messages/${encodeURIComponent(messageId)}`;
  }

  private toListItem(message: z.infer<typeof MessageSummarySchema>): InboxListItem {
    return {
      ref: encodeOutlookInboxReference({ profile: this.profile, messageId: message.id }),
      messageId: message.id,
      unread: !message.isRead,
      flagged: message.flag?.flagStatus?.toLowerCase() === 'flagged',
      from: address(message.from),
      subject: cleanLine(message.subject, 500),
      receivedAt: cleanLine(message.receivedDateTime, 100) || null,
      size: null
    };
  }

  async list(unread: boolean, limit: number): Promise<InboxListResult> {
    const params = new URLSearchParams();
    params.set('$select', 'id,isRead,flag,from,subject,receivedDateTime,hasAttachments');
    params.set('$orderby', 'receivedDateTime desc');
    params.set('$top', String(unread ? OUTLOOK_LIST_SCAN_LIMIT : limit));
    const query = params.toString().replace(/\+/g, '%20');
    const body = ListResponseSchema.parse(await this.json(
      `${GRAPH_ORIGIN}${this.basePath}/mailFolders/inbox/messages?${query}`,
      { redirect: 'error', headers: this.headers() }
    ));
    const matches = unread ? body.value.filter((message) => !message.isRead) : body.value;
    return {
      items: matches.slice(0, limit).map((message) => this.toListItem(message)),
      scannedUidWindow: body.value.length,
      truncated: matches.length > limit || typeof body['@odata.nextLink'] === 'string'
    };
  }

  async read(encodedReference: string): Promise<InboxMessage> {
    const reference = this.messageReference(encodedReference);
    const select = 'id,isRead,flag,from,toRecipients,ccRecipients,subject,receivedDateTime,body,hasAttachments';
    const message = MessageSummarySchema.parse(await this.json(
      `${this.messageUrl(reference.messageId)}?$select=${select}`,
      { redirect: 'error', headers: this.headers() }
    ));
    if (message.id !== reference.messageId) throw new Error('Message reference is stale');

    let attachments: InboxMessage['attachments'] = [];
    if (message.hasAttachments) {
      const response = AttachmentsResponseSchema.parse(await this.json(
        `${this.messageUrl(reference.messageId)}/attachments?$select=name,contentType,size&$top=50`,
        { redirect: 'error', headers: this.headers() }
      ));
      attachments = response.value.map((item) => ({
        filename: cleanLine(item.name, 300) || null,
        contentType: cleanLine(item.contentType, 200),
        size: item.size ?? 0
      }));
    }

    const content = cleanBody(message.body?.content);
    const isHtml = message.body?.contentType.toLowerCase() === 'html';
    return {
      ...this.toListItem(message),
      to: addresses(message.toRecipients),
      cc: addresses(message.ccRecipients),
      text: isHtml ? '' : content,
      html: isHtml ? content : null,
      attachments
    };
  }

  async markRead(encodedReferences: string[]): Promise<MailboxMarkReadResult> {
    const references = decodeUniqueInboxReferences(encodedReferences);
    if (references.some((reference) =>
      reference.v !== 2 || reference.backend !== 'outlook' || reference.profile !== this.profile
    )) {
      throw new Error('Mailbox reference belongs to a different profile');
    }
    let verified = 0;
    for (const reference of references as OutlookInboxReference[]) {
      try {
        const update = await this.graph.request(this.messageUrl(reference.messageId), {
          method: 'PATCH',
          redirect: 'error',
          headers: this.headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ isRead: true })
        });
        if (!update.ok) {
          await update.body?.cancel().catch(() => {});
          continue;
        }
        await update.body?.cancel().catch(() => {});
        const check = MessageSummarySchema.pick({ id: true, isRead: true }).parse(await this.json(
          `${this.messageUrl(reference.messageId)}?$select=id,isRead`,
          { redirect: 'error', headers: this.headers() }
        ));
        if (check.id === reference.messageId && check.isRead) verified += 1;
      } catch {
        // Exact mark-read is idempotent; return a partial result instead of widening scope.
      }
    }
    return {
      outcome: verified === references.length ? 'applied' : 'partial',
      requested: references.length,
      verified
    };
  }

  async prepareTrash(draft: MailboxTrashDraft): Promise<OutlookMailboxTrashSnapshot> {
    if (draft.provider !== this.providerName) throw new Error('Mailbox reference belongs to a different profile');
    const references = decodeUniqueInboxReferences(draft.payload.refs);
    if (references.some((reference) =>
      reference.v !== 2 || reference.backend !== 'outlook' || reference.profile !== this.profile
    )) {
      throw new Error('Mailbox reference belongs to a different profile');
    }
    const outlookReferences = references as OutlookInboxReference[];
    const items = [];
    for (const reference of outlookReferences) {
      const message = MessagePreviewSchema.parse(await this.json(
        `${this.messageUrl(reference.messageId)}?$select=id,from,subject,receivedDateTime`,
        { redirect: 'error', headers: this.headers() }
      ));
      if (message.id !== reference.messageId) throw new Error('Message reference is stale');
      items.push({
        messageId: message.id,
        from: address(message.from),
        subject: cleanLine(message.subject, 300) || '[no subject]',
        receivedAt: cleanLine(message.receivedDateTime, 100) || null,
        size: null
      });
    }
    return {
      backend: 'outlook',
      provider: this.providerName,
      profile: this.profile,
      account: this.address,
      sourcePath: 'Inbox',
      trashPath: 'Deleted Items',
      messageIds: outlookReferences.map((reference) => reference.messageId),
      items
    };
  }

  async executeTrash(snapshot: MailboxTrashSnapshot): Promise<MailboxTrashResult> {
    if (
      snapshot.backend !== 'outlook' ||
      snapshot.provider !== this.providerName ||
      snapshot.profile !== this.profile ||
      snapshot.account !== this.address
    ) {
      throw new Error('Approved mailbox snapshot is unavailable');
    }
    let moved = 0;
    for (const messageId of snapshot.messageIds) {
      try {
        const movedMessage = MessagePreviewSchema.parse(await this.json(`${this.messageUrl(messageId)}/move`, {
          method: 'POST',
          redirect: 'error',
          headers: this.headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ destinationId: 'deleteditems' })
        }));
        if (movedMessage.id === messageId) moved += 1;
      } catch {
        // A network failure after POST is ambiguous. Never retry automatically.
      }
    }
    return moved === snapshot.messageIds.length
      ? {
          outcome: 'moved',
          requestedCount: snapshot.messageIds.length,
          verifiedMovedCount: moved,
          details: `Microsoft Graph verified ${moved} exact move(s) to Deleted Items`
        }
      : {
          outcome: 'move-partial',
          requestedCount: snapshot.messageIds.length,
          verifiedMovedCount: moved,
          details: 'One or more Outlook move outcomes were rejected or ambiguous; do not retry automatically'
        };
  }

  async prepareUnsubscribe(draft: MailboxUnsubscribeDraft): Promise<MailboxUnsubscribeSnapshot> {
    if (draft.provider !== this.providerName) throw new Error('Mailbox reference belongs to a different profile');
    return this.prepareUnsubscribeReference(draft.payload.ref);
  }

  async prepareUnsubscribeReference(encodedReference: string): Promise<MailboxUnsubscribeSnapshot> {
    const reference = this.messageReference(encodedReference);
    const message = HeaderMessageSchema.parse(await this.json(
      `${this.messageUrl(reference.messageId)}?$select=id,from,subject,receivedDateTime,internetMessageHeaders`,
      { redirect: 'error', headers: this.headers() }
    ));
    if (message.id !== reference.messageId) throw new Error('Message reference is stale');
    const rawHeaders = Buffer.from(message.internetMessageHeaders
      .filter((header) => {
        const name = header.name.toLowerCase();
        return name === 'list-unsubscribe' || name === 'list-unsubscribe-post';
      })
      .map((header) => `${header.name}: ${header.value}\r\n`)
      .join(''), 'utf8');
    const selected = selectUnsubscribeMethod(rawHeaders);
    return {
      backend: 'outlook',
      provider: this.providerName,
      profile: this.profile,
      account: this.address,
      sourcePath: 'Inbox',
      messageId: reference.messageId,
      from: address(message.from),
      subjectLine: cleanLine(message.subject, 500) || '[no subject]',
      receivedAt: cleanLine(message.receivedDateTime, 100) || null,
      ...selected
    };
  }

  async executeHttps(
    snapshot: Extract<MailboxUnsubscribeSnapshot, { method: 'rfc8058-https-post' }>
  ): Promise<MailboxUnsubscribeResult> {
    if (
      snapshot.backend !== 'outlook' ||
      snapshot.provider !== this.providerName ||
      snapshot.profile !== this.profile ||
      snapshot.account !== this.address
    ) {
      throw new Error('Approved unsubscribe profile changed');
    }
    return executeHttpsUnsubscribe(snapshot);
  }
}
