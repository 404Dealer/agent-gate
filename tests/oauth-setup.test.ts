import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPkceChallenge } from '../src/oauth/pkce.js';
import { createOAuthCallbackListener } from '../src/oauth/callback.js';
import { PassSecretStore } from '../src/oauth/secret-store.js';
import { updateProviderConfig, validateProviderConfigTarget } from '../src/oauth/config-writer.js';
import { buildGmailAuthorizationUrl, exchangeGmailAuthorizationCode, fetchGmailIdentity } from '../src/oauth/gmail.js';
import { buildOutlookAuthorizationUrl, exchangeOutlookAuthorizationCode, requestOutlookDeviceCode, pollOutlookDeviceToken, fetchOutlookIdentity } from '../src/oauth/outlook.js';
import { persistGmailOnboarding, persistOutlookOnboarding, persistZohoOnboarding } from '../src/oauth/persist.js';
import { parseOAuthSetupArgs } from '../src/oauth/cli-options.js';
import { buildZohoAuthorizationUrl, exchangeZohoAuthorizationCode, fetchZohoSenderChoices, getZohoRegionEndpoints, validateZohoCallbackRegion } from '../src/oauth/zoho.js';
import { parseSelection, sanitizeTerminalText } from '../src/oauth/selection.js';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const assertVersionedCredentialKeys = (keys: string[], bases: string[]): string => {
  assert.equal(keys.length, bases.length);
  const suffixes = bases.map((base) => {
    const key = keys.find((candidate) => candidate.startsWith(`agent-gate/${base}-`));
    assert(key, `missing versioned key for ${base}`);
    const match = key.match(new RegExp(`^agent-gate/${base}-([a-f0-9]{24})$`));
    assert(match, `invalid versioned key for ${base}`);
    return match[1];
  });
  assert.equal(new Set(suffixes).size, 1);
  return suffixes[0];
};

test('PKCE challenge matches the RFC 7636 S256 example', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(createPkceChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('OAuth setup CLI accepts only non-secret options and makes device code Outlook-only', () => {
  assert.deepEqual(parseOAuthSetupArgs(['gmail', '--config', '/opt/agent-gate/config/config.yaml', '--port', '8765']), {
    provider: 'gmail',
    configPath: '/opt/agent-gate/config/config.yaml',
    port: 8765,
    deviceCode: false
  });
  assert.deepEqual(parseOAuthSetupArgs(['outlook', '--device-code']), {
    provider: 'outlook',
    configPath: '/opt/agent-gate/config/config.yaml',
    port: 8765,
    deviceCode: true
  });
  assert.throws(
    () => parseOAuthSetupArgs(['gmail', '--client-secret', 'must-not-enter-argv']),
    /Unknown option/
  );
  assert.throws(() => parseOAuthSetupArgs(['zoho', '--device-code']), /only valid for outlook/);
});

test('production installer validates canonical safe arguments without side effects', () => {
  const installerPath = fileURLToPath(new URL('../scripts/install-production.sh', import.meta.url));
  const validate = (functionName: string, value: string): number | null => spawnSync(
    '/bin/bash',
    ['-c', 'source "$1"; "$2" "$3"', 'installer-validation', installerPath, functionName, value],
    { encoding: 'utf8' }
  ).status;

  assert.equal(validate('validate_install_dir', '/opt/agent-gate'), 0);
  for (const unsafePath of ['/', '/opt', '/tmp/agent-gate', '/opt/../etc', '/opt//agent-gate', '/opt/agent-gate\nInjected=true']) {
    assert.notEqual(validate('validate_install_dir', unsafePath), 0, unsafePath);
  }

  assert.equal(validate('validate_telegram_user_id', '2061243435'), 0);
  for (const unsafeId of ['0', '-1', '1\nallowedUsers: [2]', '9007199254740992']) {
    assert.notEqual(validate('validate_telegram_user_id', unsafeId), 0, unsafeId);
  }

  assert.equal(validate('validate_agent_user', 'spacex'), 0);
  for (const unsafeUser of ['root;id', '--help', 'UpperCase', 'space user']) {
    assert.notEqual(validate('validate_agent_user', unsafeUser), 0, unsafeUser);
  }
});

test('interactive selection is explicit, bounded, and terminal-safe', () => {
  assert.equal(parseSelection('2', 3), 1);
  assert.throws(() => parseSelection('0', 3), /between 1 and 3/);
  assert.throws(() => parseSelection('4', 3), /between 1 and 3/);
  assert.throws(() => parseSelection('1.5', 3), /between 1 and 3/);
  assert.equal(sanitizeTerminalText('safe\u001b[31mred\u0007\u202Eevil'), 'safe[31mredevil');
});

test('Gmail authorization URL requests send and basic identity scopes with PKCE and state', () => {
  const url = new URL(buildGmailAuthorizationUrl({
    clientId: 'google-client-id',
    redirectUri: 'http://127.0.0.1:8765/',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }));

  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'google-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8765/');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/gmail.send');
  assert.equal(url.searchParams.get('access_type'), null);
  assert.equal(url.searchParams.get('include_granted_scopes'), null);
  assert.equal(url.searchParams.get('prompt'), 'consent select_account');
  assert.equal(url.searchParams.get('code_challenge'), 'pkce-challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.throws(() => buildGmailAuthorizationUrl({
    clientId: 'google-client-id',
    redirectUri: 'http://user@127.0.0.1:8765/',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }), /loopback root/);
  assert.throws(() => buildGmailAuthorizationUrl({
    clientId: 'google-client-id',
    redirectUri: 'http://127.0.0.1:8765/?unexpected=1',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }), /loopback root/);
});

test('Gmail exchanges a public-client code with PKCE and verifies returned scopes', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      scope: 'email https://www.googleapis.com/auth/gmail.send openid'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;

  const tokens = await exchangeGmailAuthorizationCode({
    clientId: 'google-client-id',
    code: 'authorization-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: 'http://127.0.0.1:8765/'
  }, fetchFn);

  assert.deepEqual(tokens, { accessToken: 'access-token', refreshToken: 'refresh-token' });
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(calls[0].init?.redirect, 'error');
  assert(calls[0].init?.signal instanceof AbortSignal);
  const body = calls[0].init?.body as URLSearchParams;
  assert.equal(body.get('code'), 'authorization-code');
  assert.equal(body.get('code_verifier'), 'pkce-verifier');
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_secret'), null);
});

test('Gmail rejects a token response missing an approved required scope', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    scope: 'openid email'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

  await assert.rejects(() => exchangeGmailAuthorizationCode({
    clientId: 'google-client-id',
    code: 'authorization-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: 'http://127.0.0.1:8765/'
  }, fetchFn), /missing required scope/);
});

test('Gmail OIDC identity lookup returns a verified authenticated address', async () => {
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://openidconnect.googleapis.com/v1/userinfo');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer temporary-access-token');
    assert.equal(init?.redirect, 'error');
    assert(init?.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ email: 'owner@gmail.com', email_verified: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;

  assert.equal(await fetchGmailIdentity('temporary-access-token', fetchFn), 'owner@gmail.com');
});

test('Gmail OIDC identity rejects terminal-control characters in email metadata', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    email: 'owner@gmail.com\u001b[31m',
    email_verified: true
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

  await assert.rejects(() => fetchGmailIdentity('temporary-access-token', fetchFn), /verified email address/);
});

test('Outlook authorization URL uses a public-client loopback redirect, PKCE, and state', () => {
  const url = new URL(buildOutlookAuthorizationUrl({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    redirectUri: 'http://localhost:8765/microsoft/oauth/callback',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }));

  assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('client_id'), 'microsoft-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8765/microsoft/oauth/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('response_mode'), 'query');
  assert.equal(url.searchParams.get('scope'), 'offline_access Mail.Send User.Read');
  assert.equal(url.searchParams.get('code_challenge'), 'pkce-challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.throws(() => buildOutlookAuthorizationUrl({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    redirectUri: 'http://user@localhost:8765/microsoft/oauth/callback',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }), /registered localhost callback/);
  assert.throws(() => buildOutlookAuthorizationUrl({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    redirectUri: 'http://localhost:8765/microsoft/oauth/callback#fragment',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }), /registered localhost callback/);
});

test('Outlook exchanges a public-client authorization code with PKCE', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      scope: 'Mail.Send User.Read'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  assert.deepEqual(await exchangeOutlookAuthorizationCode({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    code: 'authorization-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: 'http://localhost:8765/microsoft/oauth/callback'
  }, fetchFn), { accessToken: 'access-token', refreshToken: 'refresh-token' });

  assert.equal(calls[0].url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  assert.equal(calls[0].init?.redirect, 'error');
  const body = calls[0].init?.body as URLSearchParams;
  assert.equal(body.get('code'), 'authorization-code');
  assert.equal(body.get('code_verifier'), 'pkce-verifier');
  assert.equal(body.get('client_secret'), null);
  assert(calls[0].init?.signal instanceof AbortSignal);
});

test('Outlook accepts an omitted scope field after requesting the fixed approved scope set', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'refresh-token'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

  assert.deepEqual(await exchangeOutlookAuthorizationCode({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    code: 'authorization-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: 'http://localhost:8765/microsoft/oauth/callback'
  }, fetchFn), { accessToken: 'access-token', refreshToken: 'refresh-token' });
});

test('Outlook device authorization requests only offline mail-send and profile scopes', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      device_code: 'device-code',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 900,
      interval: 5,
      message: 'Open the browser and enter the code.'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const result = await requestOutlookDeviceCode({ clientId: 'microsoft-client-id', tenantId: 'common' }, fetchFn);
  assert.equal(result.deviceCode, 'device-code');
  assert.equal(result.userCode, 'ABCD-EFGH');
  assert.equal(result.verificationUri, 'https://microsoft.com/devicelogin');
  assert.equal(calls[0].url, 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode');
  assert.equal(calls[0].init?.redirect, 'error');
  assert(calls[0].init?.signal instanceof AbortSignal);
  const body = calls[0].init?.body as URLSearchParams;
  assert.equal(body.get('client_id'), 'microsoft-client-id');
  assert.equal(body.get('scope'), 'offline_access Mail.Send User.Read');
});

test('Outlook device authorization rejects a non-Microsoft verification URI', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    device_code: 'device-code',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://attacker.example/phish',
    expires_in: 900,
    interval: 5
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

  await assert.rejects(
    () => requestOutlookDeviceCode({ clientId: 'microsoft-client-id', tenantId: 'common' }, fetchFn),
    /trusted Microsoft HTTPS URL/
  );
});

test('Outlook device token polling handles pending and slow_down without exposing tokens', async () => {
  const responses = [
    new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({ error: 'slow_down' }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', scope: 'Mail.Send User.Read' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  ];
  const delays: number[] = [];
  const fetchFn = (async () => responses.shift()!) as typeof fetch;
  const sleepFn = async (milliseconds: number) => { delays.push(milliseconds); };

  const tokens = await pollOutlookDeviceToken({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    deviceCode: 'device-code',
    expiresIn: 900,
    interval: 5
  }, fetchFn, sleepFn);

  assert.deepEqual(tokens, { accessToken: 'access-token', refreshToken: 'refresh-token' });
  assert.deepEqual(delays, [5_000, 5_000, 10_000]);
});

test('Outlook device token polling backs off after a transient network failure', async () => {
  const delays: number[] = [];
  let attempt = 0;
  const fetchFn = (async () => {
    attempt += 1;
    if (attempt === 1) throw new TypeError('simulated network failure');
    return new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      scope: 'Mail.Send User.Read'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const tokens = await pollOutlookDeviceToken({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    deviceCode: 'device-code',
    expiresIn: 900,
    interval: 5
  }, fetchFn, async (milliseconds: number) => { delays.push(milliseconds); });

  assert.deepEqual(tokens, { accessToken: 'access-token', refreshToken: 'refresh-token' });
  assert.deepEqual(delays, [5_000, 10_000]);
});

test('Outlook device polling never sleeps or requests beyond the authorization deadline', async () => {
  let now = 0;
  let fetchCalls = 0;
  const delays: number[] = [];
  const fetchFn = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ error: 'expired_token' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;
  const sleepFn = async (milliseconds: number) => {
    delays.push(milliseconds);
    now += milliseconds;
  };

  await assert.rejects(() => pollOutlookDeviceToken({
    clientId: 'microsoft-client-id',
    tenantId: 'common',
    deviceCode: 'device-code',
    expiresIn: 2,
    interval: 5
  }, fetchFn, sleepFn, () => now), /expired/);

  assert.deepEqual(delays, [2_000]);
  assert.equal(fetchCalls, 0);
});

test('Outlook identity lookup prefers mail and falls back to userPrincipalName', async () => {
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer temporary-access-token');
    return new Response(JSON.stringify({
      mail: 'owner@outlook.com',
      userPrincipalName: 'owner@example.onmicrosoft.com',
      displayName: 'Hash Bringer'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  assert.deepEqual(await fetchOutlookIdentity('temporary-access-token', fetchFn), {
    email: 'owner@outlook.com',
    displayName: 'Hash Bringer'
  });
});

test('Outlook identity rejects control characters and sanitizes display metadata', async () => {
  const unsafeEmailFetch = (async () => new Response(JSON.stringify({
    mail: 'owner@outlook.com\u001b[31m',
    displayName: 'Hash Bringer'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  await assert.rejects(() => fetchOutlookIdentity('temporary-access-token', unsafeEmailFetch), /valid mailbox address/);

  const unsafeNameFetch = (async () => new Response(JSON.stringify({
    mail: 'owner@outlook.com',
    displayName: 'Hash\u001b[31m\u202E Bringer'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  assert.deepEqual(await fetchOutlookIdentity('temporary-access-token', unsafeNameFetch), {
    email: 'owner@outlook.com',
    displayName: 'Hash[31m Bringer'
  });
});

test('Zoho authorization is pinned to explicit Accounts/Mail data-center pairs', () => {
  const expected = {
    us: ['https://accounts.zoho.com', 'https://mail.zoho.com'],
    eu: ['https://accounts.zoho.eu', 'https://mail.zoho.eu'],
    in: ['https://accounts.zoho.in', 'https://mail.zoho.in'],
    au: ['https://accounts.zoho.com.au', 'https://mail.zoho.com.au'],
    jp: ['https://accounts.zoho.jp', 'https://mail.zoho.jp'],
    ca: ['https://accounts.zohocloud.ca', 'https://mail.zohocloud.ca'],
    sa: ['https://accounts.zoho.sa', 'https://mail.zoho.sa']
  } as const;
  for (const [region, [accountsBaseUrl, mailApiBaseUrl]] of Object.entries(expected)) {
    assert.deepEqual(getZohoRegionEndpoints(region as keyof typeof expected), { accountsBaseUrl, mailApiBaseUrl });
  }
  for (const unmapped of ['uk', 'sg', 'cn', 'ae', 'inec', 'https://attacker.example']) {
    assert.throws(() => getZohoRegionEndpoints(unmapped as any), /Unsupported Zoho region/);
  }

  const url = new URL(buildZohoAuthorizationUrl({
    region: 'eu',
    clientId: 'zoho-client-id',
    redirectUri: 'http://127.0.0.1:8765/zoho/oauth/callback',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }));
  assert.equal(url.origin + url.pathname, 'https://accounts.zoho.eu/oauth/v2/auth');
  assert.equal(url.searchParams.get('scope'), 'ZohoMail.messages.CREATE,ZohoMail.accounts.READ');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('code_challenge'), 'pkce-challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.throws(() => buildZohoAuthorizationUrl({
    region: 'eu',
    clientId: 'zoho-client-id',
    redirectUri: 'http://user@127.0.0.1:8765/zoho/oauth/callback',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }), /exact local Zoho callback/);
  assert.throws(() => buildZohoAuthorizationUrl({
    region: 'eu',
    clientId: 'zoho-client-id',
    redirectUri: 'http://127.0.0.1:8765/zoho/oauth/callback?unexpected=1',
    state: 'state-value',
    codeChallenge: 'pkce-challenge'
  }), /exact local Zoho callback/);
});

test('Zoho exchanges an authorization code at the selected data center', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      scope: 'ZohoMail.messages.CREATE ZohoMail.accounts.READ'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;

  const tokens = await exchangeZohoAuthorizationCode({
    region: 'eu',
    clientId: 'zoho-client-id',
    clientSecret: 'zoho-client-secret',
    code: 'authorization-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: 'http://127.0.0.1:8765/zoho/oauth/callback'
  }, fetchFn);
  assert.deepEqual(tokens, { accessToken: 'access-token', refreshToken: 'refresh-token' });
  assert.equal(calls[0].url, 'https://accounts.zoho.eu/oauth/v2/token');
  assert.equal(calls[0].init?.redirect, 'error');
  const body = calls[0].init?.body as URLSearchParams;
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'authorization-code');
  assert.equal(body.get('code_verifier'), 'pkce-verifier');
  assert.equal(body.get('scope'), 'ZohoMail.messages.CREATE,ZohoMail.accounts.READ');
  assert(calls[0].init?.signal instanceof AbortSignal);
});

test('Zoho rejects a token response that does not prove the required grants', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    scope: 'ZohoMail.accounts.READ'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

  await assert.rejects(() => exchangeZohoAuthorizationCode({
    region: 'eu',
    clientId: 'zoho-client-id',
    clientSecret: 'zoho-client-secret',
    code: 'authorization-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: 'http://127.0.0.1:8765/zoho/oauth/callback'
  }, fetchFn), /missing required scope/);
});

test('Zoho account lookup returns explicit confirmed sender choices', async () => {
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://mail.zoho.eu/api/accounts');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Zoho-oauthtoken temporary-access-token');
    assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify({
      data: [
        {
          accountId: '123456789',
          displayName: 'Hash Bringer',
          primaryEmailAddress: 'owner@example.eu',
          emailAddress: [
            { mailId: 'unconfirmed@example.eu', isPrimary: false, isConfirmed: false },
            { mailId: 'alias@example.eu', isPrimary: false, isConfirmed: true }
          ],
          sendMailDetails: [{ fromAddress: 'sales@example.eu' }]
        },
        {
          accountId: '987654321',
          displayName: 'Second Account',
          primaryEmailAddress: 'second@example.eu'
        }
      ]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  assert.deepEqual(await fetchZohoSenderChoices('eu', 'temporary-access-token', fetchFn), [
    { accountId: '123456789', email: 'owner@example.eu', displayName: 'Hash Bringer' },
    { accountId: '123456789', email: 'alias@example.eu', displayName: 'Hash Bringer' },
    { accountId: '123456789', email: 'sales@example.eu', displayName: 'Hash Bringer' },
    { accountId: '987654321', email: 'second@example.eu', displayName: 'Second Account' }
  ]);
});

test('Zoho account lookup rejects unsafe account identifiers and sanitizes display metadata', async () => {
  const unsafeAccountFetch = (async () => new Response(JSON.stringify({
    data: [{ accountId: '123\u001b[31m', primaryEmailAddress: 'owner@example.eu' }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  await assert.rejects(
    () => fetchZohoSenderChoices('eu', 'temporary-access-token', unsafeAccountFetch),
    /eligible account and sender address/
  );

  const unsafeNameFetch = (async () => new Response(JSON.stringify({
    data: [{
      accountId: '123456789',
      primaryEmailAddress: 'owner@example.eu',
      displayName: 'Hash\u001b[31m\u202E Bringer'
    }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  assert.deepEqual(await fetchZohoSenderChoices('eu', 'temporary-access-token', unsafeNameFetch), [{
    accountId: '123456789',
    email: 'owner@example.eu',
    displayName: 'Hash[31m Bringer'
  }]);
});

test('Zoho callback regional hints must match the selected allowlisted data center', () => {
  assert.doesNotThrow(() => validateZohoCallbackRegion('eu', {
    location: 'EU',
    accountsServer: 'https://accounts.zoho.eu'
  }));
  assert.throws(() => validateZohoCallbackRegion('eu', { location: 'us' }), /does not match/);
  assert.throws(
    () => validateZohoCallbackRegion('eu', { accountsServer: 'https://attacker.example' }),
    /does not match/
  );
  assert.throws(
    () => validateZohoCallbackRegion('eu', { accountsServer: 'https://user@accounts.zoho.eu' }),
    /does not match/
  );
});

test('OAuth callback enforces path/state, returns allowed metadata, and stops after one success', async () => {
  const listener = await createOAuthCallbackListener({
    expectedState: 'expected-state',
    callbackPath: '/zoho/oauth/callback',
    port: 0,
    timeoutMs: 2_000
  });
  try {
    const wrongPath = await fetch(listener.redirectUri.replace('/zoho/oauth/callback', '/callback') + '?code=attacker-code&state=expected-state');
    assert.equal(wrongPath.status, 404);

    const wrongMethod = await fetch(listener.redirectUri, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);

    const missingCode = await fetch(`${listener.redirectUri}?state=expected-state`);
    assert.equal(missingCode.status, 400);

    const wrongState = await fetch(`${listener.redirectUri}?code=attacker-code&state=wrong-state`);
    assert.equal(wrongState.status, 400);
    assert.match(await wrongState.text(), /state/i);

    const duplicateState = await fetch(`${listener.redirectUri}?code=attacker-code&state=expected-state&state=wrong-state`);
    assert.equal(duplicateState.status, 400);
    assert.match(await duplicateState.text(), /duplicate/i);

    const duplicateCode = await fetch(`${listener.redirectUri}?code=attacker-code&code=second-code&state=expected-state`);
    assert.equal(duplicateCode.status, 400);
    assert.match(await duplicateCode.text(), /duplicate/i);

    const accepted = fetch(`${listener.redirectUri}?code=valid-code&state=expected-state&location=eu&accounts-server=https%3A%2F%2Faccounts.zoho.eu`);
    assert.deepEqual(await listener.result, {
      code: 'valid-code',
      location: 'eu',
      accountsServer: 'https://accounts.zoho.eu'
    });
    assert.equal((await accepted).status, 200);

    await assert.rejects(() => fetch(`${listener.redirectUri}?code=second-code&state=expected-state`));
  } finally {
    await listener.close();
  }
});

test('OAuth callback does not expose provider error descriptions', async () => {
  const listener = await createOAuthCallbackListener({
    expectedState: 'expected-state',
    callbackPath: '/test/oauth/callback',
    port: 0,
    timeoutMs: 2_000
  });
  try {
    const responsePromise = fetch(`${listener.redirectUri}?error=access_denied&error_description=secret-provider-detail&state=expected-state`);
    await assert.rejects(listener.result, (error: unknown) => {
      assert(error instanceof Error);
      assert.doesNotMatch(error.message, /secret-provider-detail/);
      return true;
    });
    assert.equal((await responsePromise).status, 400);
  } finally {
    await listener.close();
  }
});

test('pass secret store sends the secret through stdin and never command arguments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-pass-test-'));
  try {
    const executable = join(dir, 'fake-pass');
    const argsPath = join(dir, 'args.txt');
    const stdinPath = join(dir, 'stdin.txt');
    await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_PASS_ARGS"\ncat > "$FAKE_PASS_STDIN"\n', 'utf8');
    await chmod(executable, 0o700);

    const secret = 'refresh-token-value-that-must-not-be-in-argv';
    const store = new PassSecretStore({
      executable,
      env: { ...process.env, FAKE_PASS_ARGS: argsPath, FAKE_PASS_STDIN: stdinPath }
    });
    await store.set('agent-gate/google-refresh-token', secret);

    const args = await readFile(argsPath, 'utf8');
    assert.equal(args, 'insert\n--force\n--multiline\nagent-gate/google-refresh-token\n');
    assert.doesNotMatch(args, /refresh-token-value/);
    assert.equal(await readFile(stdinPath, 'utf8'), `${secret}\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pass secret store rejects terminal-control characters before spawning', async () => {
  const store = new PassSecretStore({ executable: '/bin/false' });
  await assert.rejects(
    () => store.set('agent-gate/test-secret', 'secret\u202Evalue'),
    /printable single-line/
  );
});

test('pass secret store times out a hung password-store process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-pass-timeout-'));
  try {
    const executable = join(dir, 'hung-pass');
    await writeFile(executable, '#!/bin/sh\nsleep 30\n', 'utf8');
    await chmod(executable, 0o700);
    const store = new PassSecretStore({ executable, env: process.env, timeoutMs: 50 });

    await assert.rejects(
      () => store.set('agent-gate/google-refresh-token', 'temporary-test-token'),
      /timed out/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('production OAuth wrapper is root-protected and starts agentgate with a clean environment', async () => {
  const wrapper = await readFile(new URL('../scripts/oauth-setup.sh', import.meta.url), 'utf8');
  const manualHelper = await readFile(new URL('../scripts/configure-provider-secrets.sh', import.meta.url), 'utf8');
  const installer = await readFile(new URL('../scripts/install-production.sh', import.meta.url), 'utf8');
  const oauthCli = await readFile(new URL('../src/oauth-setup.ts', import.meta.url), 'utf8');

  assert.match(wrapper, /runuser -u "\$SERVICE_USER" -- env -i/);
  assert.match(wrapper, /readonly TRUSTED_PATH=/);
  assert.match(wrapper, /resolve_trusted_executable node/);
  assert.match(wrapper, /healthy_checks=/);
  assert.match(wrapper, /systemctl is-active --quiet "\$SERVICE_NAME"/);
  assert.match(wrapper, /CONFIG_PATH="\$INSTALL_DIR\/config\/config\.yaml"/);
  assert.doesNotMatch(wrapper, /AGENT_GATE_CONFIG:-/);
  assert.match(installer, /SOURCE_DIR=.*BASH_SOURCE/);
  assert.match(installer, /"\$SOURCE_DIR"\/ "\$INSTALL_DIR"\//);
  assert.match(installer, /Refusing symbolic link at protected install path/);
  assert.match(installer, /rsync -a --delete --chown=root:root/);
  assert.doesNotMatch(installer, /chown -R root:root "\$INSTALL_DIR"/);
  assert.match(installer, /chmod 711 "\$INSTALL_DIR"/);
  assert.match(installer, /chown root:root "\$INSTALL_DIR\/scripts"/);
  assert.match(installer, /chmod 755 "\$INSTALL_DIR\/scripts"/);
  assert.match(installer, /chown root:root[\s\\]+"\$INSTALL_DIR\/scripts\/oauth-setup\.sh"/);
  assert.match(installer, /chown -R "\$SERVICE_USER:\$SERVICE_GROUP" "\$CONFIG_DIR"/);
  assert.match(installer, /Environment=AGENT_GATE_CONFIG=\$CONFIG_DIR\/config\.yaml/);
  assert.match(installer, /BUILD_USER="agentgate-build-\$\$"/);
  assert.match(installer, /runuser -u "\$BUILD_USER" -- env -i/);
  assert.doesNotMatch(installer, /runuser -u "\$SERVICE_USER" -- env -i[\s\S]*?npm/);
  assert.match(installer, /find "\$BUILD_ROOT\/dist" -type l -print -quit/);
  assert.doesNotMatch(installer, /chown -R "\$SERVICE_USER:\$SERVICE_GROUP" "\$INSTALL_DIR"/);
  assert.match(manualHelper, /if \[\[ ! -t 0 \|\| ! -t 1 \]\]/);
  assert.match(manualHelper, /resolve_trusted_executable pass/);
  assert.match(manualHelper, /"\$PASS_BIN" insert --force --multiline/);
});

test('provider config update is atomic, contains pass references, and remains mode 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-oauth-config-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, `
telegram:
  botToken: "\${PASS:agent-gate/telegram-bot-token}"
  allowedUsers: [2061243435]
watch:
  directory: ./drafts/inbox
providers:
  log:
    type: log-only
defaults:
  provider: log
  timezone: UTC
audit:
  enabled: true
  logFile: ./audit.log
`, { encoding: 'utf8', mode: 0o600 });

    await updateProviderConfig(configPath, 'gmail', {
      type: 'email-gmail',
      clientId: '${PASS:agent-gate/google-client-id}',
      refreshToken: '${PASS:agent-gate/google-refresh-token}',
      fromAddress: 'owner@gmail.com'
    }, true);

    const parsed = YAML.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(parsed.providers.gmail.refreshToken, '${PASS:agent-gate/google-refresh-token}');
    assert.equal(parsed.providers.gmail.fromAddress, 'owner@gmail.com');
    assert.equal(parsed.defaults.provider, 'gmail');
    assert.equal((await lstat(configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider config writer rejects group/world-readable targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-oauth-mode-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'providers: {}\ndefaults: {}\n', { mode: 0o644 });
    await assert.rejects(
      () => updateProviderConfig(configPath, 'gmail', { type: 'email-gmail' }, false),
      /mode 0600/
    );
    await chmod(configPath, 0o400);
    await assert.rejects(
      () => validateProviderConfigTarget(configPath),
      /mode 0600/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuth persistence validates private config before writing any secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-oauth-preflight-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'providers: {}\ndefaults: {}\n', { mode: 0o644 });
    const writes: string[] = [];
    const store = { set: async (key: string) => { writes.push(key); } };

    await assert.rejects(() => persistGmailOnboarding({
      configPath,
      store,
      clientId: 'google-client-id',
      refreshToken: 'refresh-token',
      email: 'owner@gmail.com',
      setAsDefault: false
    }), /mode 0600/);
    assert.deepEqual(writes, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuth persistence never overwrites live credentials before the config commit succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-oauth-rollback-'));
  try {
    const configPath = join(dir, 'config.yaml');
    const originalConfig = 'providers: {}\ndefaults:\n  provider: log\n';
    await writeFile(configPath, originalConfig, { encoding: 'utf8', mode: 0o600 });
    const stored = new Map<string, string>([
      ['agent-gate/google-client-id', 'existing-client-id'],
      ['agent-gate/google-refresh-token', 'existing-refresh-token']
    ]);
    let writes = 0;
    const store = {
      set: async (key: string, value: string) => {
        stored.set(key, value);
        writes += 1;
        if (writes === 1) await chmod(configPath, 0o644);
      }
    };

    await assert.rejects(() => persistGmailOnboarding({
      configPath,
      store,
      clientId: 'replacement-client-id',
      refreshToken: 'replacement-refresh-token',
      email: 'replacement@gmail.com',
      setAsDefault: true
    }), /mode 0600/);

    assert.equal(stored.get('agent-gate/google-client-id'), 'existing-client-id');
    assert.equal(stored.get('agent-gate/google-refresh-token'), 'existing-refresh-token');
    assert.equal(await readFile(configPath, 'utf8'), originalConfig);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuth persistence rejects concurrent onboarding for the same config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-oauth-lock-'));
  let releaseFirstWrite!: () => void;
  let signalFirstWrite!: () => void;
  let first: Promise<void> | undefined;
  const firstWriteStarted = new Promise<void>((resolve) => { signalFirstWrite = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'providers: {}\ndefaults:\n  provider: log\n', { encoding: 'utf8', mode: 0o600 });
    first = persistGmailOnboarding({
      configPath,
      store: {
        set: async () => {
          signalFirstWrite();
          await release;
        }
      },
      clientId: 'first-client-id',
      refreshToken: 'first-refresh-token',
      email: 'first@gmail.com',
      setAsDefault: false
    });
    await firstWriteStarted;

    await assert.rejects(() => persistGmailOnboarding({
      configPath,
      store: { set: async () => undefined },
      clientId: 'second-client-id',
      refreshToken: 'second-refresh-token',
      email: 'second@gmail.com',
      setAsDefault: false
    }), /already in progress/);

    releaseFirstWrite();
    await first;
  } finally {
    releaseFirstWrite?.();
    await first?.catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test('Gmail persistence stores no temporary access token and writes only pass references', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-gmail-persist-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'providers: {}\ndefaults:\n  provider: log\n', { encoding: 'utf8', mode: 0o600 });
    const stored = new Map<string, string>();
    const store = { set: async (key: string, value: string) => { stored.set(key, value); } };

    await persistGmailOnboarding({
      configPath,
      store,
      clientId: 'google-client-id',
      refreshToken: 'long-lived-refresh-token',
      email: 'owner@gmail.com',
      displayName: 'Hash Bringer',
      setAsDefault: false
    });

    const keys = [...stored.keys()].sort();
    const suffix = assertVersionedCredentialKeys(keys, ['google-client-id', 'google-refresh-token']);
    assert(![...stored.values()].includes('temporary-access-token'));
    const parsed = YAML.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(parsed.providers.gmail.clientId, `\${PASS:agent-gate/google-client-id-${suffix}}`);
    assert.equal(parsed.providers.gmail.clientSecret, undefined);
    assert.equal(parsed.providers.gmail.refreshToken, `\${PASS:agent-gate/google-refresh-token-${suffix}}`);
    assert.equal(parsed.providers.gmail.fromAddress, 'owner@gmail.com');
    assert.equal(parsed.defaults.provider, 'log');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Outlook persistence stores a public-client refresh token without a client secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-outlook-persist-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'providers: {}\ndefaults:\n  provider: log\n', { encoding: 'utf8', mode: 0o600 });
    const stored = new Map<string, string>();
    const store = { set: async (key: string, value: string) => { stored.set(key, value); } };

    await persistOutlookOnboarding({
      configPath,
      store,
      clientId: 'microsoft-client-id',
      refreshToken: 'microsoft-refresh-token',
      tenantId: 'common',
      email: 'owner@outlook.com',
      displayName: 'Hash Bringer',
      setAsDefault: true
    });

    const keys = [...stored.keys()].sort();
    const suffix = assertVersionedCredentialKeys(keys, ['microsoft-client-id', 'microsoft-refresh-token']);
    const parsed = YAML.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(parsed.providers.outlook.clientId, `\${PASS:agent-gate/microsoft-client-id-${suffix}}`);
    assert.equal(parsed.providers.outlook.clientSecret, undefined);
    assert.equal(parsed.providers.outlook.refreshToken, `\${PASS:agent-gate/microsoft-refresh-token-${suffix}}`);
    assert.equal(parsed.providers.outlook.refreshTokenKey, `agent-gate/microsoft-refresh-token-${suffix}`);
    assert.equal(parsed.providers.outlook.tenantId, 'common');
    assert.equal(parsed.providers.outlook.fromAddress, 'owner@outlook.com');
    assert.equal(parsed.defaults.provider, 'outlook');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Zoho persistence stores credentials and pins the provider region', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gate-zoho-persist-'));
  try {
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'providers: {}\ndefaults:\n  provider: log\n', { encoding: 'utf8', mode: 0o600 });
    const stored = new Map<string, string>();
    const store = { set: async (key: string, value: string) => { stored.set(key, value); } };

    await persistZohoOnboarding({
      configPath,
      store,
      clientId: 'zoho-client-id',
      clientSecret: 'zoho-client-secret',
      refreshToken: 'zoho-refresh-token',
      region: 'eu',
      accountId: '123456789',
      email: 'owner@example.eu',
      displayName: 'Hash Bringer',
      setAsDefault: false
    });

    const keys = [...stored.keys()].sort();
    const suffix = assertVersionedCredentialKeys(keys, ['zoho-client-id', 'zoho-client-secret', 'zoho-refresh-token']);
    const parsed = YAML.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(parsed.providers.zoho.clientId, `\${PASS:agent-gate/zoho-client-id-${suffix}}`);
    assert.equal(parsed.providers.zoho.clientSecret, `\${PASS:agent-gate/zoho-client-secret-${suffix}}`);
    assert.equal(parsed.providers.zoho.refreshToken, `\${PASS:agent-gate/zoho-refresh-token-${suffix}}`);
    assert.equal(parsed.providers.zoho.region, 'eu');
    assert.equal(parsed.providers.zoho.accountId, '123456789');
    assert.equal(parsed.providers.zoho.fromAddress, 'owner@example.eu');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
