import type { ProviderConfig } from '../config.js';
import type { Draft } from '../schema.js';
import { getZohoRegionEndpoints } from '../oauth/zoho.js';
import type { Provider, ProviderResult } from './index.js';

interface ZohoTokenResponse {
  access_token?: string;
  expires_in?: number | string;
}

const PROVIDER_FETCH_TIMEOUT_MS = 30_000;

const statusMessage = (prefix: string, status: number): string => `${prefix}: HTTP ${status}`;

const escapeHeaderValue = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();

const formatMailbox = (email: string, displayName?: string): string => {
  const cleanEmail = escapeHeaderValue(email);
  const cleanName = displayName ? escapeHeaderValue(displayName) : '';
  if (!cleanName) return cleanEmail;
  const quotedName = cleanName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${quotedName}" <${cleanEmail}>`;
};

export class ZohoEmailProvider implements Provider {
  private cachedAccessToken?: { value: string; expiresAt: number };
  private pendingAccessToken?: Promise<string>;

  constructor(private readonly providerConfig: Extract<ProviderConfig, { type: 'email-zoho' }>) {}

  describeSender(): string {
    return formatMailbox(this.providerConfig.fromAddress, this.providerConfig.displayName);
  }

  private async refreshAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      refresh_token: this.providerConfig.refreshToken,
      client_id: this.providerConfig.clientId,
      client_secret: this.providerConfig.clientSecret,
      grant_type: 'refresh_token'
    });
    const { accountsBaseUrl } = getZohoRegionEndpoints(this.providerConfig.region);

    const response = await fetch(new URL('/oauth/v2/token', accountsBaseUrl), {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(statusMessage('Zoho token refresh failed', response.status));
    }

    let token: ZohoTokenResponse;
    try {
      token = await response.json() as ZohoTokenResponse;
    } catch {
      throw new Error('Zoho token refresh returned invalid JSON');
    }
    const accessToken = token.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new Error('Zoho token refresh succeeded but no access_token was returned');
    }
    const expiresInSeconds = Number(token.expires_in);
    if (Number.isFinite(expiresInSeconds) && expiresInSeconds > 60) {
      this.cachedAccessToken = {
        value: accessToken,
        expiresAt: Date.now() + expiresInSeconds * 1_000
      };
    }
    return accessToken;
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedAccessToken && Date.now() + 60_000 < this.cachedAccessToken.expiresAt) {
      return this.cachedAccessToken.value;
    }
    if (this.pendingAccessToken) return this.pendingAccessToken;

    const pending = this.refreshAccessToken();
    this.pendingAccessToken = pending;
    try {
      return await pending;
    } finally {
      if (this.pendingAccessToken === pending) this.pendingAccessToken = undefined;
    }
  }

  async send(draft: Draft): Promise<ProviderResult> {
    if (draft.type !== 'email') {
      throw new Error('email-zoho provider only supports email drafts');
    }

    let accessToken = await this.getAccessToken();
    const payload = draft.payload as {
      to: string | string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      replyTo?: string;
    };

    const { mailApiBaseUrl } = getZohoRegionEndpoints(this.providerConfig.region);
    const endpoint = new URL(`/api/accounts/${encodeURIComponent(this.providerConfig.accountId)}/messages`, mailApiBaseUrl);
    const sendWithToken = (token: string): Promise<Response> => fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
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
      }),
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS)
    });

    let response = await sendWithToken(accessToken);
    if (response.status === 401) {
      if (this.cachedAccessToken?.value === accessToken) this.cachedAccessToken = undefined;
      accessToken = await this.getAccessToken();
      response = await sendWithToken(accessToken);
    }
    if (!response.ok) {
      throw new Error(statusMessage('Zoho send failed', response.status));
    }

    let result: { data?: { messageId?: string } };
    try {
      result = await response.json() as { data?: { messageId?: string } };
    } catch {
      throw new Error('Zoho send returned invalid JSON');
    }
    return {
      providerMessageId: result.data?.messageId,
      details: 'Email sent via Zoho'
    };
  }
}
