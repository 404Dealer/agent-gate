import { isSafeEmailAddress, isSafeZohoAccountId, sanitizeMetadataText } from './metadata.js';

export type ZohoRegion = 'us' | 'eu' | 'in' | 'au' | 'jp' | 'ca' | 'sa';
const OAUTH_FETCH_TIMEOUT_MS = 30_000;
const ZOHO_REQUIRED_SCOPES = ['ZohoMail.messages.CREATE', 'ZohoMail.accounts.READ'] as const;
const ZOHO_SCOPE_VALUE = ZOHO_REQUIRED_SCOPES.join(',');

export interface ZohoRegionEndpoints {
  accountsBaseUrl: string;
  mailApiBaseUrl: string;
}

// Explicit pairs only: never derive a Mail host from an Accounts host. Regions
// listed by only one Zoho product (for example UK/SG or CN/UAE) fail closed.
const ZOHO_REGIONS: Record<ZohoRegion, ZohoRegionEndpoints> = {
  us: { accountsBaseUrl: 'https://accounts.zoho.com', mailApiBaseUrl: 'https://mail.zoho.com' },
  eu: { accountsBaseUrl: 'https://accounts.zoho.eu', mailApiBaseUrl: 'https://mail.zoho.eu' },
  in: { accountsBaseUrl: 'https://accounts.zoho.in', mailApiBaseUrl: 'https://mail.zoho.in' },
  au: { accountsBaseUrl: 'https://accounts.zoho.com.au', mailApiBaseUrl: 'https://mail.zoho.com.au' },
  jp: { accountsBaseUrl: 'https://accounts.zoho.jp', mailApiBaseUrl: 'https://mail.zoho.jp' },
  ca: { accountsBaseUrl: 'https://accounts.zohocloud.ca', mailApiBaseUrl: 'https://mail.zohocloud.ca' },
  sa: { accountsBaseUrl: 'https://accounts.zoho.sa', mailApiBaseUrl: 'https://mail.zoho.sa' }
};

export function getZohoRegionEndpoints(region: ZohoRegion): ZohoRegionEndpoints {
  const endpoints = ZOHO_REGIONS[region];
  if (!endpoints) throw new Error('Unsupported Zoho region');
  return endpoints;
}

export function parseZohoRegion(value: string): ZohoRegion {
  if (Object.prototype.hasOwnProperty.call(ZOHO_REGIONS, value)) return value as ZohoRegion;
  throw new Error('Zoho region must be one of: us, eu, in, au, jp, ca, sa');
}

interface ZohoCallbackRegionHints {
  location?: string;
  accountsServer?: string;
}

export function validateZohoCallbackRegion(region: ZohoRegion, hints: ZohoCallbackRegionHints): void {
  const expected = getZohoRegionEndpoints(region).accountsBaseUrl;
  if (hints.location && hints.location.toLowerCase() !== region) {
    throw new Error('Zoho callback data center does not match the selected region');
  }
  if (hints.accountsServer) {
    let normalized: string;
    try {
      const supplied = new URL(hints.accountsServer);
      normalized = supplied.pathname === '/'
        && !supplied.search
        && !supplied.hash
        && !supplied.username
        && !supplied.password
        ? supplied.origin
        : '';
    } catch {
      normalized = '';
    }
    if (normalized !== expected) {
      throw new Error('Zoho callback accounts server does not match the selected region');
    }
  }
}

interface ZohoAuthorizationUrlOptions {
  region: ZohoRegion;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

const assertZohoLoopbackRedirect = (redirectUri: string): void => {
  const redirect = new URL(redirectUri);
  if (
    redirect.protocol !== 'http:'
    || redirect.hostname !== '127.0.0.1'
    || redirect.pathname !== '/zoho/oauth/callback'
    || redirect.username !== ''
    || redirect.password !== ''
    || redirect.search !== ''
    || redirect.hash !== ''
    || redirect.port === ''
  ) {
    throw new Error('Zoho OAuth redirect must use the exact local Zoho callback');
  }
};

export function buildZohoAuthorizationUrl(options: ZohoAuthorizationUrlOptions): string {
  assertZohoLoopbackRedirect(options.redirectUri);

  const { accountsBaseUrl } = getZohoRegionEndpoints(options.region);
  const url = new URL('/oauth/v2/auth', accountsBaseUrl);
  url.search = new URLSearchParams({
    scope: ZOHO_SCOPE_VALUE,
    client_id: options.clientId,
    response_type: 'code',
    access_type: 'offline',
    redirect_uri: options.redirectUri,
    prompt: 'consent',
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    state: options.state
  }).toString();
  return url.toString();
}

interface ZohoCodeExchangeOptions {
  region: ZohoRegion;
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

interface OAuthTokenPair {
  accessToken: string;
  refreshToken: string;
}

const assertZohoScopes = (scopeValue: unknown): void => {
  if (typeof scopeValue !== 'string') {
    throw new Error('Zoho OAuth token exchange did not return approved scopes');
  }
  const returned = new Set(scopeValue.split(/[\s,]+/).filter(Boolean).map((scope) => scope.toLowerCase()));
  for (const required of ZOHO_REQUIRED_SCOPES) {
    if (!returned.has(required.toLowerCase())) {
      throw new Error(`Zoho OAuth token exchange is missing required scope: ${required}`);
    }
  }
};

export async function exchangeZohoAuthorizationCode(
  options: ZohoCodeExchangeOptions,
  fetchFn: typeof fetch = fetch
): Promise<OAuthTokenPair> {
  assertZohoLoopbackRedirect(options.redirectUri);
  const { accountsBaseUrl } = getZohoRegionEndpoints(options.region);
  const response = await fetchFn(new URL('/oauth/v2/token', accountsBaseUrl), {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      code: options.code,
      code_verifier: options.codeVerifier,
      scope: ZOHO_SCOPE_VALUE
    }),
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Zoho OAuth token exchange failed: ${response.status} ${response.statusText || 'Unknown error'}`);
  }
  let body: { access_token?: unknown; refresh_token?: unknown; scope?: unknown };
  try {
    body = await response.json() as typeof body;
  } catch {
    throw new Error('Zoho OAuth token exchange returned invalid JSON');
  }
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error('Zoho OAuth token exchange did not return an access_token');
  }
  if (typeof body.refresh_token !== 'string' || !body.refresh_token) {
    throw new Error('Zoho OAuth token exchange did not return a refresh_token; revoke prior consent and retry');
  }
  assertZohoScopes(body.scope);
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

export interface ZohoSenderChoice {
  accountId: string;
  email: string;
  displayName?: string;
}

const validEmail = (value: unknown): value is string => isSafeEmailAddress(value);

const senderAddressesFromAccount = (account: Record<string, unknown>): string[] => {
  const addresses: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (!validEmail(value)) return;
    const normalized = value.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      addresses.push(value);
    }
  };

  add(account.primaryEmailAddress);

  if (Array.isArray(account.emailAddress)) {
    for (const value of account.emailAddress) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      if (entry.isConfirmed === true || entry.isPrimary === true) {
        add(entry.mailId);
        add(entry.emailAddress);
      }
    }
  } else {
    add(account.emailAddress);
  }

  if (Array.isArray(account.sendMailDetails)) {
    for (const value of account.sendMailDetails) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      if (entry.isEnabled === false || String(entry.status ?? '').toLowerCase() === 'disabled') continue;
      add(entry.fromAddress);
    }
  }

  if (addresses.length === 0) {
    add(account.incomingUserName);
    add(account.accountName);
  }
  return addresses;
};

export async function fetchZohoSenderChoices(
  region: ZohoRegion,
  accessToken: string,
  fetchFn: typeof fetch = fetch
): Promise<ZohoSenderChoice[]> {
  const { mailApiBaseUrl } = getZohoRegionEndpoints(region);
  const response = await fetchFn(new URL('/api/accounts', mailApiBaseUrl), {
    redirect: 'error',
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Zoho account lookup failed: ${response.status} ${response.statusText || 'Unknown error'}`);
  }

  let body: { data?: unknown };
  try {
    body = await response.json() as { data?: unknown };
  } catch {
    throw new Error('Zoho account lookup returned invalid JSON');
  }

  const candidates = Array.isArray(body.data) ? body.data : [body.data];
  const choices: ZohoSenderChoice[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const account = candidate as Record<string, unknown>;
    const accountId = isSafeZohoAccountId(account.accountId) ? account.accountId : '';
    if (!accountId) continue;
    const displayName = sanitizeMetadataText(account.displayName);
    for (const email of senderAddressesFromAccount(account)) {
      choices.push({ accountId, email, ...(displayName ? { displayName } : {}) });
    }
  }
  if (choices.length === 0) {
    throw new Error('Zoho account lookup did not return an eligible account and sender address');
  }
  return choices;
}
