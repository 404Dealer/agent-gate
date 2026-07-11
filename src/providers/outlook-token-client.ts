import type { ProviderConfig } from '../config.js';
import type { SecretStore } from '../oauth/persist.js';
import { PassSecretStore } from '../oauth/secret-store.js';

interface OutlookTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

const PROVIDER_FETCH_TIMEOUT_MS = 30_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const sharedClients = new WeakMap<object, OutlookTokenClient>();

async function readTokenResponse(response: Response): Promise<OutlookTokenResponse> {
  if (!response.body) throw new Error('Outlook token refresh returned an invalid response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_TOKEN_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('Outlook token refresh returned an invalid response');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as OutlookTokenResponse;
  } catch {
    throw new Error('Outlook token refresh returned an invalid response');
  }
}

const statusMessage = (prefix: string, status: number): string => `${prefix}: HTTP ${status}`;

export class OutlookTokenClient {
  private currentRefreshToken: string;
  private cachedAccessToken?: { value: string; expiresAt: number };
  private pendingAccessToken?: Promise<string>;

  constructor(
    private readonly config: Extract<ProviderConfig, { type: 'email-outlook' }>,
    private readonly secretStore: SecretStore = new PassSecretStore()
  ) {
    this.currentRefreshToken = config.refreshToken;
  }

  private requestedScopes(): string {
    return this.config.mailboxAccess === true
      ? 'offline_access Mail.Send Mail.ReadWrite'
      : 'offline_access Mail.Send';
  }

  private async refreshAccessToken(): Promise<string> {
    const tenantId = encodeURIComponent(this.config.tenantId ?? 'common');
    const body = new URLSearchParams({
      refresh_token: this.currentRefreshToken,
      client_id: this.config.clientId,
      grant_type: 'refresh_token',
      scope: this.requestedScopes()
    });
    if (this.config.clientSecret) body.set('client_secret', this.config.clientSecret);

    const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS)
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(statusMessage('Outlook token refresh failed', response.status));
    }

    const token = await readTokenResponse(response);
    if (typeof token.access_token !== 'string' || token.access_token.length === 0) {
      throw new Error('Outlook token refresh succeeded but no access_token was returned');
    }
    if (token.scope !== undefined) {
      if (typeof token.scope !== 'string') throw new Error('Outlook token refresh returned invalid scopes');
      const returned = token.scope.split(/\s+/).filter(Boolean).map((scope) => scope.toLowerCase());
      const required = this.config.mailboxAccess === true ? ['mail.send', 'mail.readwrite'] : ['mail.send'];
      if (required.some((scope) => !returned.some((candidate) =>
        candidate === scope || candidate.endsWith(`/${scope}`)
      ))) {
        throw new Error('Outlook token refresh is missing a required scope');
      }
    }

    if (
      typeof token.refresh_token === 'string' &&
      token.refresh_token.length > 0 &&
      token.refresh_token !== this.currentRefreshToken
    ) {
      if (this.config.refreshTokenKey) {
        await this.secretStore.set(this.config.refreshTokenKey, token.refresh_token);
      }
      this.currentRefreshToken = token.refresh_token;
    }

    const expiresInSeconds = Number(token.expires_in);
    if (Number.isFinite(expiresInSeconds) && expiresInSeconds > 60) {
      this.cachedAccessToken = {
        value: token.access_token,
        expiresAt: Date.now() + expiresInSeconds * 1_000
      };
    }
    return token.access_token;
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

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const parsed = new URL(url);
    if (
      parsed.origin !== GRAPH_ORIGIN ||
      !parsed.pathname.startsWith('/v1.0/') ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      throw new Error('Outlook Graph destination is not allowed');
    }
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'DELETE') throw new Error('Outlook permanent deletion is not available');

    const send = async (accessToken: string): Promise<Response> => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
      headers.Authorization = `Bearer ${accessToken}`;
      return fetch(parsed.toString(), {
        ...init,
        redirect: 'error',
        headers,
        signal: init.signal ?? AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS)
      });
    };

    let accessToken = await this.getAccessToken();
    let response = await send(accessToken);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      if (this.cachedAccessToken?.value === accessToken) this.cachedAccessToken = undefined;
      accessToken = await this.getAccessToken();
      response = await send(accessToken);
    }
    return response;
  }
}

export function getSharedOutlookTokenClient(
  config: Extract<ProviderConfig, { type: 'email-outlook' }>
): OutlookTokenClient {
  const existing = sharedClients.get(config);
  if (existing) return existing;
  const created = new OutlookTokenClient(config);
  sharedClients.set(config, created);
  return created;
}
