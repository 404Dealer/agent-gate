const GMAIL_APP_PASSWORD_PATTERN = /^[A-Za-z0-9]{16}$/;

export function normalizeGmailAppPassword(value: string): string {
  const normalized = value.replaceAll(' ', '');
  if (!GMAIL_APP_PASSWORD_PATTERN.test(normalized)) {
    throw new Error('Gmail App Password must contain exactly 16 ASCII letters or digits');
  }
  return normalized;
}
