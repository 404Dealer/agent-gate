import { z } from 'zod';

const InboxReferenceSchema = z.object({
  v: z.literal(1),
  folder: z.literal('inbox'),
  uidValidity: z.string().regex(/^[1-9][0-9]*$/),
  uid: z.number().int().positive().safe()
}).strict();

export type InboxReference = z.infer<typeof InboxReferenceSchema>;

export function encodeInboxReference(reference: Omit<InboxReference, 'v' | 'folder'>): string {
  return Buffer.from(JSON.stringify({ v: 1, folder: 'inbox', ...reference }), 'utf8').toString('base64url');
}

export function decodeInboxReference(encoded: string): InboxReference {
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(encoded)) throw new Error('Invalid message reference');
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    if (Buffer.byteLength(raw, 'utf8') > 512) throw new Error('oversized');
    return InboxReferenceSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('Invalid message reference');
  }
}
