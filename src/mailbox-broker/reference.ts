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
    const parsed = InboxReferenceSchema.parse(JSON.parse(raw));
    if (encoded !== encodeInboxReference({ uidValidity: parsed.uidValidity, uid: parsed.uid })) {
      throw new Error('non-canonical');
    }
    return parsed;
  } catch {
    throw new Error('Invalid message reference');
  }
}

export function decodeUniqueInboxReferences(encodedRefs: readonly string[]): InboxReference[] {
  const refs = encodedRefs.map((ref) => decodeInboxReference(ref));
  const uidValidity = refs[0]?.uidValidity;
  if (!uidValidity || refs.some((ref) => ref.uidValidity !== uidValidity)) {
    throw new Error('Mailbox references must share one current INBOX identity');
  }
  const identities = new Set(refs.map((ref) => `${ref.uidValidity}:${ref.uid}`));
  if (identities.size !== refs.length) throw new Error('Duplicate mailbox references are not allowed');
  return refs;
}
