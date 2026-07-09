import { isSafeEmailAddress, sanitizeMetadataText } from './metadata.js';

const OUTLOOK_SCOPES = 'offline_access Mail.Send User.Read';
const OUTLOOK_REQUIRED_RESOURCE_SCOPES = ['Mail.Send', 'User.Read'] as const;
const OAUTH_FETCH_TIMEOUT_MS = 30_000;

const tenantSegment = (tenantId: string): string => {
  const value = tenantId || 'common';
  if (!/^[A-Za-z0-9.-]{1,255}$/.test(value)) throw new Error('Invalid Microsoft tenant ID or alias');
  return encodeURIComponent(value);
};

const assertOutlookLoopbackRedirect = (redirectUri: string): void => {
  const redirect = new URL(redirectUri);
  if (
    redirect.protocol !== 'http:'
    || redirect.hostname !== 'localhost'
    || redirect.pathname !== '/microsoft/oauth/callback'
    || redirect.username !== ''
    || redirect.password !== ''
    || redirect.search !== ''
    || redirect.hash !== ''
    || redirect.port === ''
  ) {
    throw new Error('Outlook OAuth redirect must use the registered localhost callback');
  }
};

const assertOutlookScopes = (scopeValue: unknown): void => {
  if (typeof scopeValue !== 'string') throw new Error('Outlook token response did not return approved scopes');
  const returned = scopeValue.split(/\s+/).filter(Boolean).map((scope) => scope.toLowerCase());
  for (const required of OUTLOOK_REQUIRED_RESOURCE_SCOPES) {
    const expected = required.toLowerCase();
    if (!returned.some((scope) => scope === expected || scope.endsWith(`/${expected}`))) {
      throw new Error(`Outlook token response is missing required scope: ${required}`);
    }
  }
};

interface OutlookAuthorizationUrlOptions {
  clientId: string;
  tenantId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export function buildOutlookAuthorizationUrl(options: OutlookAuthorizationUrlOptions): string {
  assertOutlookLoopbackRedirect(options.redirectUri);
  const url = new URL(`https://login.microsoftonline.com/${tenantSegment(options.tenantId)}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: OUTLOOK_SCOPES,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    state: options.state,
    prompt: 'select_account'
  }).toString();
  return url.toString();
}

interface OutlookCodeExchangeOptions {
  clientId: string;
  tenantId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

interface OAuthTokenPair {
  accessToken: string;
  refreshToken: string;
}

export async function exchangeOutlookAuthorizationCode(
  options: OutlookCodeExchangeOptions,
  fetchFn: typeof fetch = fetch
): Promise<OAuthTokenPair> {
  assertOutlookLoopbackRedirect(options.redirectUri);
  const endpoint = `https://login.microsoftonline.com/${tenantSegment(options.tenantId)}/oauth2/v2.0/token`;
  const response = await fetchFn(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: options.clientId,
      code: options.code,
      code_verifier: options.codeVerifier,
      redirect_uri: options.redirectUri,
      grant_type: 'authorization_code',
      scope: OUTLOOK_SCOPES
    }),
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Outlook OAuth token exchange failed: ${response.status} ${response.statusText || 'Unknown error'}`);
  }
  let body: Record<string, unknown>;
  try {
    body = await response.json() as Record<string, unknown>;
  } catch {
    throw new Error('Outlook OAuth token exchange returned invalid JSON');
  }
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error('Outlook OAuth token exchange did not return an access_token');
  }
  if (typeof body.refresh_token !== 'string' || !body.refresh_token) {
    throw new Error('Outlook OAuth token exchange did not return a refresh_token');
  }
  if (body.scope !== undefined) assertOutlookScopes(body.scope);
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

interface OutlookDeviceCodeOptions {
  clientId: string;
  tenantId: string;
}

export interface OutlookDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  message?: string;
}

export async function requestOutlookDeviceCode(
  options: OutlookDeviceCodeOptions,
  fetchFn: typeof fetch = fetch
): Promise<OutlookDeviceAuthorization> {
  const tenantId = tenantSegment(options.tenantId);
  const response = await fetchFn(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: options.clientId, scope: OUTLOOK_SCOPES }),
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Outlook device authorization failed: ${response.status} ${response.statusText || 'Unknown error'}`);
  }

  let body: Record<string, unknown>;
  try {
    body = await response.json() as Record<string, unknown>;
  } catch {
    throw new Error('Outlook device authorization returned invalid JSON');
  }

  if (typeof body.device_code !== 'string' || !body.device_code ||
      typeof body.user_code !== 'string' || !body.user_code ||
      typeof body.verification_uri !== 'string' || !body.verification_uri ||
      typeof body.expires_in !== 'number' || body.expires_in <= 0) {
    throw new Error('Outlook device authorization response is missing required fields');
  }

  let verificationUrl: URL;
  try {
    verificationUrl = new URL(body.verification_uri);
  } catch {
    throw new Error('Outlook verification URI is not a trusted Microsoft HTTPS URL');
  }
  const trustedHost = verificationUrl.hostname === 'microsoft.com' ||
    verificationUrl.hostname.endsWith('.microsoft.com') ||
    verificationUrl.hostname === 'aka.ms' ||
    verificationUrl.hostname === 'login.microsoftonline.com';
  if (verificationUrl.protocol !== 'https:' || !trustedHost || verificationUrl.username || verificationUrl.password) {
    throw new Error('Outlook verification URI is not a trusted Microsoft HTTPS URL');
  }
  if (!/^[A-Za-z0-9-]+$/.test(body.user_code)) {
    throw new Error('Outlook device authorization returned an invalid user code');
  }

  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: verificationUrl.toString(),
    expiresIn: body.expires_in,
    interval: typeof body.interval === 'number' && body.interval > 0 ? body.interval : 5,
    message: typeof body.message === 'string' ? body.message : undefined
  };
}

interface OutlookDeviceTokenOptions {
  clientId: string;
  tenantId: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
}

type SleepFn = (milliseconds: number) => Promise<void>;
type NowFn = () => number;
const sleep: SleepFn = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function pollOutlookDeviceToken(
  options: OutlookDeviceTokenOptions,
  fetchFn: typeof fetch = fetch,
  sleepFn: SleepFn = sleep,
  nowFn: NowFn = Date.now
): Promise<OAuthTokenPair> {
  const tenantId = tenantSegment(options.tenantId);
  const endpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const deadline = nowFn() + options.expiresIn * 1_000;
  let intervalMs = Math.max(1, options.interval) * 1_000;

  while (nowFn() < deadline) {
    const sleepMs = Math.min(intervalMs, deadline - nowFn());
    await sleepFn(sleepMs);
    if (nowFn() >= deadline) break;
    let response: Response;
    try {
      response = await fetchFn(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: options.clientId,
          device_code: options.deviceCode
        }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(OAUTH_FETCH_TIMEOUT_MS, deadline - nowFn())))
      });
    } catch {
      intervalMs = Math.min(intervalMs * 2, 60_000);
      continue;
    }

    let body: Record<string, unknown>;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      throw new Error('Outlook device token endpoint returned invalid JSON');
    }

    if (response.ok) {
      if (typeof body.access_token !== 'string' || !body.access_token) {
        throw new Error('Outlook device token response did not return an access_token');
      }
      if (typeof body.refresh_token !== 'string' || !body.refresh_token) {
        throw new Error('Outlook device token response did not return a refresh_token');
      }
      if (body.scope !== undefined) assertOutlookScopes(body.scope);
      return { accessToken: body.access_token, refreshToken: body.refresh_token };
    }

    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      intervalMs += 5_000;
      continue;
    }
    if (body.error === 'authorization_declined') {
      throw new Error('Outlook authorization was declined');
    }
    if (body.error === 'expired_token' || body.error === 'bad_verification_code') {
      throw new Error('Outlook device code expired or was invalid; start again');
    }
    throw new Error(`Outlook device token request failed: ${response.status} ${response.statusText || 'Unknown error'}`);
  }

  throw new Error('Outlook device code expired; start again');
}

export interface OutlookIdentity {
  email: string;
  displayName?: string;
}

export async function fetchOutlookIdentity(accessToken: string, fetchFn: typeof fetch = fetch): Promise<OutlookIdentity> {
  const response = await fetchFn('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
    redirect: 'error',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Outlook identity lookup failed: ${response.status} ${response.statusText || 'Unknown error'}`);
  }

  let body: { mail?: unknown; userPrincipalName?: unknown; displayName?: unknown };
  try {
    body = await response.json() as typeof body;
  } catch {
    throw new Error('Outlook identity lookup returned invalid JSON');
  }

  const email = isSafeEmailAddress(body.mail)
    ? body.mail
    : isSafeEmailAddress(body.userPrincipalName)
      ? body.userPrincipalName
      : undefined;
  if (!email) {
    throw new Error('Outlook identity lookup did not return a valid mailbox address');
  }
  const displayName = sanitizeMetadataText(body.displayName);
  return {
    email,
    ...(displayName ? { displayName } : {})
  };
}
