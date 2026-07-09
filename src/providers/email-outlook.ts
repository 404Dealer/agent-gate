import type { ProviderConfig } from '../config.js';
import type { Draft } from '../schema.js';
import type { Provider, ProviderResult } from './index.js';

interface OutlookTokenResponse {
  access_token: string;
}

const statusMessage = (prefix: string, status: number, statusText: string): string =>
  `${prefix}: ${status} ${statusText || 'Unknown error'}`;

const normalizeRecipients = (value: string | string[] | undefined): string[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const escapeHeaderValue = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();

const formatMailbox = (email: string, displayName?: string): string => {
  const cleanEmail = escapeHeaderValue(email);
  const cleanName = displayName ? escapeHeaderValue(displayName) : '';
  if (!cleanName) return cleanEmail;
  const quotedName = cleanName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${quotedName}" <${cleanEmail}>`;
};

const graphRecipients = (value: string | string[] | undefined): Array<{ emailAddress: { address: string } }> =>
  normalizeRecipients(value).map((address) => ({ emailAddress: { address: escapeHeaderValue(address) } }));

export class OutlookEmailProvider implements Provider {
  constructor(private readonly providerConfig: Extract<ProviderConfig, { type: 'email-outlook' }>) {}

  describeSender(): string {
    return formatMailbox(this.providerConfig.fromAddress, this.providerConfig.displayName);
  }

  private async getAccessToken(): Promise<string> {
    const tenantId = encodeURIComponent(this.providerConfig.tenantId ?? 'common');
    const body = new URLSearchParams({
      refresh_token: this.providerConfig.refreshToken,
      client_id: this.providerConfig.clientId,
      client_secret: this.providerConfig.clientSecret,
      grant_type: 'refresh_token',
      scope: 'offline_access Mail.Send'
    });

    const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    if (!response.ok) {
      throw new Error(statusMessage('Outlook token refresh failed', response.status, response.statusText));
    }

    const token = (await response.json()) as OutlookTokenResponse;
    return token.access_token;
  }

  private buildGraphMessage(draft: Draft): Record<string, unknown> {
    const payload = draft.payload as {
      to: string | string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      replyTo?: string;
    };

    const message: Record<string, unknown> = {
      subject: escapeHeaderValue(payload.subject),
      body: {
        contentType: 'HTML',
        content: payload.body
      },
      toRecipients: graphRecipients(payload.to),
      ccRecipients: graphRecipients(payload.cc),
      bccRecipients: graphRecipients(payload.bcc)
    };

    const replyTo = graphRecipients(payload.replyTo);
    if (replyTo.length > 0) {
      message.replyTo = replyTo;
    }

    return message;
  }

  async send(draft: Draft): Promise<ProviderResult> {
    if (draft.type !== 'email') {
      throw new Error('email-outlook provider only supports email drafts');
    }

    const accessToken = await this.getAccessToken();
    const endpoint = this.providerConfig.userId
      ? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.providerConfig.userId)}/sendMail`
      : 'https://graph.microsoft.com/v1.0/me/sendMail';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: this.buildGraphMessage(draft),
        saveToSentItems: true
      })
    });

    if (!response.ok) {
      throw new Error(statusMessage('Outlook send failed', response.status, response.statusText));
    }

    return {
      details: 'Email sent via Outlook / Microsoft Graph'
    };
  }
}
