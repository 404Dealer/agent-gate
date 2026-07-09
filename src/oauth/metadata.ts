const UNSAFE_TEXT_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_TEXT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const LOCAL_PART = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function isSafeEmailAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 320 || UNSAFE_TEXT_CHARACTER.test(value) || /\s/.test(value)) {
    return false;
  }
  const separator = value.indexOf('@');
  if (separator <= 0 || separator !== value.lastIndexOf('@')) return false;

  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  if (local.length > 64 || !LOCAL_PART.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return false;
  }
  if (!domain || domain.length > 253) return false;
  return domain.split('.').every((label) => DOMAIN_LABEL.test(label));
}

export function sanitizeMetadataText(value: unknown, maximumLength = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = value.replace(UNSAFE_TEXT_CHARACTERS, '').trim().slice(0, maximumLength);
  return sanitized || undefined;
}

export function isSafeZohoAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,64}$/.test(value);
}
