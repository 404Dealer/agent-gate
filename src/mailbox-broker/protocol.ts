import { z } from 'zod';
import { decodeInboxReference, decodeUniqueInboxReferences } from './reference.js';

export const MAILBOX_SOCKET_PATH = '/run/agent-gate-mailbox/broker.sock';
export const MAX_REQUEST_BYTES = 16 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

const RequestBase = z.object({
  v: z.literal(1),
  id: z.string().uuid()
});

const MessageRefSchema = z.string().min(8).max(256).regex(/^[A-Za-z0-9_-]+$/).refine((value) => {
  try {
    decodeInboxReference(value);
    return true;
  } catch {
    return false;
  }
}, 'Invalid canonical message reference');

const UniqueMessageRefsSchema = z.array(MessageRefSchema).min(1).max(20).superRefine((refs, ctx) => {
  try {
    decodeUniqueInboxReferences(refs);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'Invalid mailbox references' });
  }
});

export const MailboxRequestSchema = z.discriminatedUnion('op', [
  RequestBase.extend({
    op: z.literal('list'),
    unread: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(20)
  }).strict(),
  RequestBase.extend({
    op: z.literal('read'),
    ref: MessageRefSchema
  }).strict(),
  RequestBase.extend({
    op: z.literal('mark-read'),
    refs: UniqueMessageRefsSchema
  }).strict(),
  RequestBase.extend({
    op: z.literal('propose-trash'),
    refs: UniqueMessageRefsSchema,
    context: z.string().max(1000)
  }).strict()
]);

export type MailboxRequest = z.infer<typeof MailboxRequestSchema>;

export const MailboxResponseSchema = z.discriminatedUnion('ok', [
  z.object({ v: z.literal(1), id: z.string().uuid(), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ v: z.literal(1), id: z.string().uuid(), ok: z.literal(false), error: z.string().min(1).max(200) }).strict()
]);

export type MailboxResponse = z.infer<typeof MailboxResponseSchema>;
