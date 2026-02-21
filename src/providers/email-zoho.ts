import type { ProviderConfig } from '../config.js';
import type { Draft } from '../schema.js';
import type { Provider, ProviderResult } from './index.js';

interface ZohoTokenResponse {
  access_token: string;
}

const statusMessage = (prefix: string, status: number, statusText: string): string =>
  `${prefix}: ${status} ${statusText || 'Unknown error'}`;

export class ZohoEmailProvider implements Provider {
  constructor(private readonly providerConfig: Extract<ProviderConfig, { type: 'email-zoho' }>) {}

  private async getAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      refresh_token: this.providerConfig.refreshToken,
      client_id: this.providerConfig.clientId,
      client_secret: this.providerConfig.clientSecret,
      grant_type: 'refresh_token'
    });

    const response = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    if (!response.ok) {
      throw new Error(statusMessage('Zoho token refresh failed', response.status, response.statusText));
    }

    const token = (await response.json()) as ZohoTokenResponse;
    return token.access_token;
  }

  async send(draft: Draft): Promise<ProviderResult> {
    if (draft.type !== 'email') {
      throw new Error('email-zoho provider only supports email drafts');
    }

    const accessToken = await this.getAccessToken();
    const payload = draft.payload as {
      to: string | string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      replyTo?: string;
    };

    const response = await fetch(`https://mail.zoho.com/api/accounts/${this.providerConfig.accountId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fromAddress: this.providerConfig.fromAddress,
        toAddress: Array.isArray(payload.to) ? payload.to.join(',') : payload.to,
        subject: payload.subject,
        content: payload.body,
        mailFormat: 'html',
        ccAddress: (payload.cc ?? []).join(','),
        bccAddress: (payload.bcc ?? []).join(','),
        replyTo: payload.replyTo ?? ''
      })
    });

    if (!response.ok) {
      throw new Error(statusMessage('Zoho send failed', response.status, response.statusText));
    }

    const result = (await response.json()) as { data?: { messageId?: string } };
    return {
      providerMessageId: result.data?.messageId,
      details: 'Email sent via Zoho'
    };
  }
}
