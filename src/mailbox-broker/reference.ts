import { z } from 'zod';

const LegacyInboxReferenceSchema = z.object({
  v: z.literal(1),
  folder: z.literal('inbox'),
  uidValidity: z.string().regex(/^[1-9][0-9]*$/),
  uid: z.number().int().positive().safe()
}).strict();

const ProfileNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

const GmailInboxReferenceSchema = z.object({
  v: z.literal(2),
  profile: ProfileNameSchema,
  backend: z.literal('gmail'),
  folder: z.literal('inbox'),
  uidValidity: z.string().regex(/^[1-9][0-9]*$/),
  uid: z.number().int().positive().safe()
}).strict();

const OutlookInboxReferenceSchema = z.object({
  v: z.literal(2),
  profile: ProfileNameSchema,
  backend: z.literal('outlook'),
  folder: z.literal('inbox'),
  messageId: z.string().regex(/^[A-Za-z0-9+\/_=-]{1,2048}$/)
}).strict();

const InboxReferenceSchema = z.union([
  LegacyInboxReferenceSchema,
  GmailInboxReferenceSchema,
  OutlookInboxReferenceSchema
]);

export type InboxReference = z.infer<typeof InboxReferenceSchema>;
export type GmailInboxReference = Extract<InboxReference, { v: 1 } | { backend: 'gmail' }>;
export type OutlookInboxReference = Extract<InboxReference, { backend: 'outlook' }>;

type LegacyReferenceInput = Omit<z.infer<typeof LegacyInboxReferenceSchema>, 'v' | 'folder'>;
type GmailReferenceInput = Omit<z.infer<typeof GmailInboxReferenceSchema>, 'v' | 'folder'>;

export function encodeInboxReference(reference: LegacyReferenceInput | GmailReferenceInput): string {
  const value = 'profile' in reference
    ? { v: 2, profile: reference.profile, backend: 'gmail', folder: 'inbox', uidValidity: reference.uidValidity, uid: reference.uid }
    : { v: 1, folder: 'inbox', uidValidity: reference.uidValidity, uid: reference.uid };
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function encodeOutlookInboxReference(reference: { profile: string; messageId: string }): string {
  const value = OutlookInboxReferenceSchema.parse({
    v: 2,
    profile: reference.profile,
    backend: 'outlook',
    folder: 'inbox',
    messageId: reference.messageId
  });
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeInboxReference(encoded: string): InboxReference {
  if (!/^[A-Za-z0-9_-]{8,4096}$/.test(encoded)) throw new Error('Invalid message reference');
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    if (Buffer.byteLength(raw, 'utf8') > 3072) throw new Error('oversized');
    const parsed = InboxReferenceSchema.parse(JSON.parse(raw));
    const canonical = parsed.v === 1
      ? encodeInboxReference({ uidValidity: parsed.uidValidity, uid: parsed.uid })
      : parsed.backend === 'gmail'
        ? encodeInboxReference({ profile: parsed.profile, backend: 'gmail', uidValidity: parsed.uidValidity, uid: parsed.uid })
        : encodeOutlookInboxReference({ profile: parsed.profile, messageId: parsed.messageId });
    if (encoded !== canonical) throw new Error('non-canonical');
    return parsed;
  } catch {
    throw new Error('Invalid message reference');
  }
}

export function decodeGmailInboxReference(encoded: string): GmailInboxReference {
  const reference = decodeInboxReference(encoded);
  if (reference.v === 2 && reference.backend !== 'gmail') throw new Error('Invalid message reference');
  return reference as GmailInboxReference;
}

const backendOf = (reference: InboxReference): 'gmail' | 'outlook' =>
  reference.v === 1 ? 'gmail' : reference.backend;

export function decodeUniqueInboxReferences(encodedRefs: readonly string[]): InboxReference[] {
  const refs = encodedRefs.map((ref) => decodeInboxReference(ref));
  const first = refs[0];
  const profile = first?.v === 2 ? first.profile : null;
  if (refs.some((ref) => (ref.v === 2 ? ref.profile : null) !== profile)) {
    throw new Error('Mailbox references must belong to one profile');
  }
  const backend = first ? backendOf(first) : null;
  if (!backend || refs.some((ref) => backendOf(ref) !== backend)) {
    throw new Error('Mailbox references must belong to one profile');
  }
  if (backend === 'gmail') {
    const gmailRefs = refs as GmailInboxReference[];
    const uidValidity = gmailRefs[0]?.uidValidity;
    if (!uidValidity || gmailRefs.some((ref) => ref.uidValidity !== uidValidity)) {
      throw new Error('Mailbox references must share one current INBOX identity');
    }
  }
  const identities = new Set(refs.map((ref) => ref.v === 2 && ref.backend === 'outlook'
    ? `outlook:${ref.messageId}`
    : `gmail:${ref.uidValidity}:${ref.uid}`
  ));
  if (identities.size !== refs.length) throw new Error('Duplicate mailbox references are not allowed');
  return refs;
}

export function decodeUniqueGmailInboxReferences(encodedRefs: readonly string[]): GmailInboxReference[] {
  const references = decodeUniqueInboxReferences(encodedRefs);
  if (references.some((reference) => reference.v === 2 && reference.backend !== 'gmail')) {
    throw new Error('Invalid message reference');
  }
  return references as GmailInboxReference[];
}
