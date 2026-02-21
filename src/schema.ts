import { z } from 'zod';

export const DraftStatusSchema = z.enum(['pending', 'approved', 'denied', 'edited', 'sent', 'failed']);
export const DraftTypeSchema = z.enum(['email', 'webhook']).catch('email');

export const EmailPayloadSchema = z.object({
  from: z.string().email(),
  to: z.union([z.string().email(), z.array(z.string().email()).min(1)]),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(262144),
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
  context: z.string().max(1000).optional().default(''),
  priority: z.string().optional().default('normal'),
  tags: z.array(z.string()).max(20).optional().default([])
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

export function updateStatus(draft: Draft, status: DraftStatus, patch?: Partial<Draft>): Draft {
  return DraftSchema.parse({
    ...draft,
    ...patch,
    status,
    updatedAt: new Date().toISOString(),
    approval: {
      ...draft.approval,
      ...patch?.approval
    }
  });
}
