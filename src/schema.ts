import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

export const DraftStatusSchema = z.enum(['pending', 'approved', 'denied', 'edited', 'sent', 'failed']);
export const DraftTypeSchema = z.enum(['email', 'webhook']).catch('email');

export const EmailPayloadSchema = z.object({
  from: z.string().email(),
  to: z.union([z.string().email(), z.array(z.string().email()).min(1)]),
  subject: z.string().min(1),
  body: z.string().min(1),
  cc: z.array(z.string().email()).optional().default([]),
  bcc: z.array(z.string().email()).optional().default([]),
  replyTo: z.string().email().optional().or(z.literal('')).default('')
});

export const WebhookPayloadSchema = z.object({
  url: z.string().url(),
  method: z.string().default('POST'),
  headers: z.record(z.string()).optional().default({}),
  body: z.unknown().optional()
});

export const ApprovalSchema = z.object({
  approvedBy: z.string().nullable().default(null),
  approvedAt: z.string().nullable().default(null),
  deniedBy: z.string().nullable().optional().default(null),
  deniedAt: z.string().nullable().optional().default(null),
  telegramMessageId: z.number().nullable().default(null),
  edits: z.array(z.record(z.unknown())).default([]),
  error: z.string().optional()
});

export const MetadataSchema = z.object({
  context: z.string().optional().default(''),
  priority: z.string().optional().default('normal'),
  tags: z.array(z.string()).optional().default([])
});

export const DraftSchema = z.object({
  id: z.string().uuid(),
  type: DraftTypeSchema,
  status: DraftStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  source: z.string(),
  provider: z.string(),
  payload: z.union([EmailPayloadSchema, WebhookPayloadSchema]),
  metadata: MetadataSchema.default({ context: '', priority: 'normal', tags: [] }),
  approval: ApprovalSchema.default({ approvedBy: null, approvedAt: null, telegramMessageId: null, edits: [] })
});

export type DraftStatus = z.infer<typeof DraftStatusSchema>;
export type DraftType = z.infer<typeof DraftTypeSchema>;
export type Draft = z.infer<typeof DraftSchema>;

export function createDraft(input: {
  type: DraftType;
  source: string;
  provider: string;
  payload: Draft['payload'];
  metadata?: Partial<Draft['metadata']>;
}): Draft {
  const now = new Date().toISOString();
  return DraftSchema.parse({
    id: uuidv4(),
    type: input.type,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    source: input.source,
    provider: input.provider,
    payload: input.payload,
    metadata: {
      context: input.metadata?.context ?? '',
      priority: input.metadata?.priority ?? 'normal',
      tags: input.metadata?.tags ?? []
    },
    approval: {
      approvedBy: null,
      approvedAt: null,
      deniedBy: null,
      deniedAt: null,
      telegramMessageId: null,
      edits: []
    }
  });
}

export function validateDraft(input: unknown): Draft {
  return DraftSchema.parse(input);
}

export function updateStatus(draft: Draft, status: DraftStatus, patch?: Partial<Draft>): Draft {
  const next = {
    ...draft,
    ...patch,
    status,
    updatedAt: new Date().toISOString(),
    approval: {
      ...draft.approval,
      ...patch?.approval
    }
  };
  return DraftSchema.parse(next);
}
