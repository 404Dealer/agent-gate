import { isSafeEmailAddress } from './metadata.js';

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const GMAIL_REQUIRED_SCOPES = ['openid', 'email', GMAIL_SEND_SCOPE] as const;
const OAUTH_FETCH_TIMEOUT_MS = 30_000;

interface GmailAuthorizationUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

const assertGmailLoopbackRedirect = (redirectUri: string): void => {
  const redirect = new URL(redirectUri);
  if (
    redirect.protocol !== 'http:'
    || redirect.hostname !== '127.0.0.1'
    || redirect.pathname !== '/'
    || redirect.username !== ''
    || redirect.password !== ''
    || redirect.search !== ''
    || redirect.hash !== ''
    || redirect.port === ''
  ) {
    throw new Error('Gmail OAuth redirect must use the local 127.0.0.1 loopback root');
  }
};

export function buildGmailAuthorizationUrl({
  clientId,
  redirectUri,
  state,
  codeChallenge
}: GmailAuthorizationUrlOptions): string {
  assertGmailLoopbackRedirect(redirectUri);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_REQUIRED_SCOPES.join(' '),
    prompt: 'consent select_account',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state
  }).toString();
  return url.toString();
}

interface GmailCodeExchangeOptions {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface OAuthTokenPair {
  accessToken: string;
  refreshToken: string;
}

const assertRequiredScopes = (scopeValue: unknown): void => {
  if (typeof scopeValue !== 'string') {
    throw new Error('Gmail OAuth token exchange did not return approved scopes');
  }
  const returned = new Set(scopeValue.split(/\s+/).filter(Boolean));
  const missing = GMAIL_REQUIRED_SCOPES.find((scope) => !returned.has(scope));
  if (missing) throw new Error(`Gmail OAuth token exchange is missing required scope: ${missing}`);
};

export async function exchangeGmailAuthorizationCode(
  options: GmailCodeExchangeOptions,
  fetchFn: typeof fetch = fetch
): Promise<OAuthTokenPair> {
  assertGmailLoopbackRedirect(options.redirectUri);
  const response = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: options.clientId,
      code: options.code,
      code_verifier: options.codeVerifier,
      redirect_uri: options.redirectUri,
      grant_type: 'authorization_code'
    }),
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Gmail OAuth token exchange failed: ${response.status} ${response.statusText || 'Unknown error'}`);
  }

  let body: { access_token?: unknown; refresh_token?: unknown; scope?: unknown };
  try {
    body = await response.json() as typeof body;
  } catch {
    throw new Error('Gmail OAuth token exchange returned invalid JSON');
  }

  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error('Gmail OAuth token exchange did not return an access_token');
  }
  if (typeof body.refresh_token !== 'string' || !body.refresh_token) {
    throw new Error('Gmail OAuth token exchange did not return a refresh_token; revoke prior consent and retry');
  }
  assertRequiredScopes(body.scope);

  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

export async function fetchGmailIdentity(accessToken: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const response = await fetchFn('https://openidconnect.googleapis.com/v1/userinfo', {
    redirect: 'error',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Gmail identity lookup failed: ${response.status} ${response.statusText || 'Unknown error'}`);
  }

  let body: { email?: unknown; email_verified?: unknown };
  try {
    body = await response.json() as typeof body;
  } catch {
    throw new Error('Gmail identity lookup returned invalid JSON');
  }

  if (body.email_verified !== true || !isSafeEmailAddress(body.email)) {
    throw new Error('Gmail identity lookup did not return a verified email address');
  }
  return body.email;
}
