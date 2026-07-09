import type { ProviderConfig } from '../config.js';
import type { Draft } from '../schema.js';
import type { Provider, ProviderResult } from './index.js';

interface GmailTokenResponse {
  access_token?: string;
}

interface GmailSendResponse {
  id?: string;
  threadId?: string;
}

const PROVIDER_FETCH_TIMEOUT_MS = 30_000;

const statusMessage = (prefix: string, status: number, statusText: string): string =>
  `${prefix}: ${status} ${statusText || 'Unknown error'}`;

const normalizeRecipients = (value: string | string[] | undefined): string => {
  if (!value) return '';
  return Array.isArray(value) ? value.join(', ') : value;
};

const escapeHeaderValue = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();

const formatMailbox = (email: string, displayName?: string): string => {
  const cleanEmail = escapeHeaderValue(email);
  const cleanName = displayName ? escapeHeaderValue(displayName) : '';
  if (!cleanName) return cleanEmail;
  const quotedName = cleanName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${quotedName}" <${cleanEmail}>`;
};

const base64url = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

export class GmailEmailProvider implements Provider {
  constructor(private readonly providerConfig: Extract<ProviderConfig, { type: 'email-gmail' }>) {}

  describeSender(): string {
    return formatMailbox(this.providerConfig.fromAddress, this.providerConfig.displayName);
  }

  private async getAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      refresh_token: this.providerConfig.refreshToken,
      client_id: this.providerConfig.clientId,
      client_secret: this.providerConfig.clientSecret,
      grant_type: 'refresh_token'
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(statusMessage('Gmail token refresh failed', response.status, response.statusText));
    }

    const token = (await response.json()) as GmailTokenResponse;
    const accessToken = token.access_token;
    if (!accessToken) {
      throw new Error('Gmail token refresh succeeded but no access_token was returned');
    }
    return accessToken;
  }

  private buildRawMessage(draft: Draft): string {
    const payload = draft.payload as {
      to: string | string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      replyTo?: string;
    };

    const headers = [
      `From: ${this.describeSender()}`,
      `To: ${escapeHeaderValue(normalizeRecipients(payload.to))}`,
      payload.cc?.length ? `Cc: ${escapeHeaderValue(normalizeRecipients(payload.cc))}` : null,
      payload.bcc?.length ? `Bcc: ${escapeHeaderValue(normalizeRecipients(payload.bcc))}` : null,
      payload.replyTo ? `Reply-To: ${escapeHeaderValue(payload.replyTo)}` : null,
      `Subject: ${escapeHeaderValue(payload.subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit'
    ].filter((line): line is string => line !== null);

    return `${headers.join('\r\n')}\r\n\r\n${payload.body}`;
  }

  async send(draft: Draft): Promise<ProviderResult> {
    if (draft.type !== 'email') {
      throw new Error('email-gmail provider only supports email drafts');
    }

    const accessToken = await this.getAccessToken();
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ raw: base64url(this.buildRawMessage(draft)) }),
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(statusMessage('Gmail send failed', response.status, response.statusText));
    }

    const result = (await response.json()) as GmailSendResponse;
    return {
      providerMessageId: result.id,
      details: result.threadId ? `Email sent via Gmail in thread ${result.threadId}` : 'Email sent via Gmail'
    };
  }
}
