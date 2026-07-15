#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseOAuthSetupArgs, type OAuthSetupOptions } from './oauth/cli-options.js';
import { createOAuthCallbackListener } from './oauth/callback.js';
import { validateProviderConfigTarget } from './oauth/config-writer.js';
import { buildGmailAuthorizationUrl, exchangeGmailAuthorizationCode, fetchGmailIdentity } from './oauth/gmail.js';
import { buildOutlookAuthorizationUrl, exchangeOutlookAuthorizationCode, fetchOutlookIdentity, pollOutlookDeviceToken, requestOutlookDeviceCode } from './oauth/outlook.js';
import { sanitizeMetadataText } from './oauth/metadata.js';
import { createPkcePair } from './oauth/pkce.js';
import { persistGmailOnboarding, persistOutlookOnboarding, persistZohoOnboarding } from './oauth/persist.js';
import { promptConfirm, promptHidden, promptText } from './oauth/prompts.js';
import { PassSecretStore } from './oauth/secret-store.js';
import { parseSelection, sanitizeTerminalText } from './oauth/selection.js';
import { buildZohoAuthorizationUrl, exchangeZohoAuthorizationCode, fetchZohoSenderChoices, parseZohoRegion, validateZohoCallbackRegion } from './oauth/zoho.js';

const usage = (): string => `Usage: nightdrop-oauth <gmail|outlook|zoho> [--profile NAME] [--config PATH] [--port PORT] [--device-code]

Browser authorization with PKCE is the default. --device-code is an Outlook-only fallback.
Run this only through scripts/oauth-setup.sh from a human-controlled SSH/local terminal.
Secrets are never accepted as command-line arguments.`;

async function assertSecureRuntime(configPath: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('OAuth setup requires a human-controlled interactive TTY');
  }
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) {
    throw new Error('OAuth setup must run as the isolated nightdrop user, never as root');
  }

  const stat = await lstat(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Nightdrop config must be a regular file, not a symlink');
  }
  if (stat.uid !== uid) {
    throw new Error('Nightdrop config must be owned by the OAuth setup user');
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error('Nightdrop config must have mode 0600 before OAuth setup');
  }
}

async function setupGmail(options: OAuthSetupOptions, store: PassSecretStore): Promise<void> {
  console.log('\nGmail secure OAuth onboarding');
  console.log('Create a Google OAuth Desktop client first. Desktop clients are public; no client secret is used.');
  const clientId = await promptText('Google OAuth client ID');
  if (!clientId) throw new Error('Google OAuth client ID is required');
  const displayName = sanitizeMetadataText(await promptText('Optional sender display name'));

  const state = randomBytes(32).toString('base64url');
  const pkce = createPkcePair();
  const listener = await createOAuthCallbackListener({
    expectedState: state,
    callbackPath: '/',
    port: options.port,
    timeoutMs: 10 * 60_000
  });

  try {
    const authorizationUrl = buildGmailAuthorizationUrl({
      clientId,
      redirectUri: listener.redirectUri,
      state,
      codeChallenge: pkce.challenge
    });
    console.log(`\nCallback URI: ${listener.redirectUri}`);
    console.log(`Ensure SSH forwards local 127.0.0.1:${options.port} to remote 127.0.0.1:${options.port}.`);
    console.log('\nOpen this URL in your local browser:\n');
    console.log(authorizationUrl);
    console.log('\nWaiting for the browser callback...');

    const callback = await listener.result;
    const tokens = await exchangeGmailAuthorizationCode({
      clientId,
      code: callback.code,
      codeVerifier: pkce.verifier,
      redirectUri: listener.redirectUri
    });
    const email = await fetchGmailIdentity(tokens.accessToken);
    const setAsDefault = await promptConfirm(`Authenticated verified account ${email}. Set Gmail as the default provider?`);

    await persistGmailOnboarding({
      configPath: options.configPath,
      store,
      clientId,
      refreshToken: tokens.refreshToken,
      email,
      displayName: displayName || undefined,
      setAsDefault
    });
    console.log(`\nGmail onboarding complete for ${email}. No token value was printed.`);
  } finally {
    await listener.close();
  }
}

async function setupOutlook(options: OAuthSetupOptions, store: PassSecretStore): Promise<void> {
  console.log('\nOutlook / Microsoft 365 secure OAuth onboarding');
  console.log('Register a Mobile and desktop application callback. No client secret is used.');
  const clientId = await promptText('Microsoft Entra application (client) ID');
  if (!clientId) throw new Error('Microsoft client ID is required');
  const tenantId = await promptText('Tenant ID (common supports personal/multi-tenant accounts)', 'common');
  const mailboxAccess = Boolean(options.profile);
  if (mailboxAccess) {
    console.log(`Mailbox profile ${options.profile} will request delegated Mail.ReadWrite access.`);
  }

  let tokens: { accessToken: string; refreshToken: string };
  if (options.deviceCode) {
    console.log('\nWARNING: device authorization is a higher-risk fallback and may be blocked by Conditional Access.');
    const authorization = await requestOutlookDeviceCode({ clientId, tenantId, mailboxAccess });
    console.log('\nOpen this Microsoft URL in any browser:');
    console.log(authorization.verificationUri);
    console.log('\nEnter this short-lived code:');
    console.log(authorization.userCode);
    console.log('\nWaiting for Microsoft authorization...');

    tokens = await pollOutlookDeviceToken({
      clientId,
      tenantId,
      deviceCode: authorization.deviceCode,
      expiresIn: authorization.expiresIn,
      interval: authorization.interval,
      mailboxAccess
    });
  } else {
    const state = randomBytes(32).toString('base64url');
    const pkce = createPkcePair();
    const listener = await createOAuthCallbackListener({
      expectedState: state,
      callbackPath: '/microsoft/oauth/callback',
      redirectHostname: 'localhost',
      port: options.port,
      timeoutMs: 10 * 60_000
    });
    try {
      const authorizationUrl = buildOutlookAuthorizationUrl({
        clientId,
        tenantId,
        redirectUri: listener.redirectUri,
        state,
        codeChallenge: pkce.challenge,
        mailboxAccess
      });
      console.log(`\nRegister/use this exact Mobile/Desktop callback URI: ${listener.redirectUri}`);
      console.log(`Ensure SSH forwards local localhost:${options.port} to remote 127.0.0.1:${options.port}.`);
      console.log('\nOpen this URL in your local browser:\n');
      console.log(authorizationUrl);
      console.log('\nWaiting for the browser callback...');
      const callback = await listener.result;
      tokens = await exchangeOutlookAuthorizationCode({
        clientId,
        tenantId,
        code: callback.code,
        codeVerifier: pkce.verifier,
        redirectUri: listener.redirectUri,
        mailboxAccess
      });
    } finally {
      await listener.close();
    }
  }

  const identity = await fetchOutlookIdentity(tokens.accessToken);
  const setAsDefault = await promptConfirm(`Authenticated ${identity.email}. Set Outlook as the default provider?`);

  await persistOutlookOnboarding({
    configPath: options.configPath,
    store,
    clientId,
    refreshToken: tokens.refreshToken,
    tenantId,
    email: identity.email,
    displayName: identity.displayName,
    setAsDefault,
    providerName: options.profile ? `outlook-${options.profile}` : 'outlook',
    mailboxProfileName: options.profile,
    mailboxAccess
  });
  console.log(`\nOutlook onboarding complete for ${identity.email}. No token value was printed.`);
}

async function setupZoho(options: OAuthSetupOptions, store: PassSecretStore): Promise<void> {
  console.log('\nZoho Mail secure OAuth onboarding');
  console.log(`Register this exact callback in Zoho API Console: http://127.0.0.1:${options.port}/zoho/oauth/callback`);
  const region = parseZohoRegion((await promptText('Zoho data center (us/eu/in/au/jp/ca/sa)', 'us')).toLowerCase());
  const clientId = await promptText('Zoho OAuth client ID');
  if (!clientId) throw new Error('Zoho OAuth client ID is required');
  const clientSecret = await promptHidden('Zoho OAuth client secret (hidden)');

  const state = randomBytes(32).toString('base64url');
  const pkce = createPkcePair();
  const listener = await createOAuthCallbackListener({
    expectedState: state,
    callbackPath: '/zoho/oauth/callback',
    port: options.port,
    timeoutMs: 10 * 60_000
  });

  try {
    const authorizationUrl = buildZohoAuthorizationUrl({
      region,
      clientId,
      redirectUri: listener.redirectUri,
      state,
      codeChallenge: pkce.challenge
    });
    console.log(`\nCallback URI: ${listener.redirectUri}`);
    console.log(`Ensure SSH forwards local 127.0.0.1:${options.port} to remote 127.0.0.1:${options.port}.`);
    console.log('\nOpen this URL in your local browser:\n');
    console.log(authorizationUrl);
    console.log('\nWaiting for the browser callback...');

    const callback = await listener.result;
    validateZohoCallbackRegion(region, callback);
    const tokens = await exchangeZohoAuthorizationCode({
      region,
      clientId,
      clientSecret,
      code: callback.code,
      codeVerifier: pkce.verifier,
      redirectUri: listener.redirectUri
    });
    const choices = await fetchZohoSenderChoices(region, tokens.accessToken);
    console.log('\nEligible Zoho sender choices:');
    choices.forEach((choice, index) => {
      const label = choice.displayName ? ` — ${sanitizeTerminalText(choice.displayName)}` : '';
      console.log(`${index + 1}. ${sanitizeTerminalText(choice.email)} (account ${sanitizeTerminalText(choice.accountId)})${label}`);
    });
    const selected = choices[parseSelection(await promptText('Select sender number'), choices.length)];
    const setAsDefault = await promptConfirm(`Use ${selected.email} and set Zoho as the default provider?`);

    await persistZohoOnboarding({
      configPath: options.configPath,
      store,
      clientId,
      clientSecret,
      refreshToken: tokens.refreshToken,
      region,
      accountId: selected.accountId,
      email: selected.email,
      displayName: selected.displayName,
      setAsDefault
    });
    console.log(`\nZoho onboarding complete for ${selected.email}. No token value was printed.`);
  } finally {
    await listener.close();
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(usage());
    return;
  }
  const options = parseOAuthSetupArgs(args);
  await assertSecureRuntime(options.configPath);
  await validateProviderConfigTarget(options.configPath);
  const store = new PassSecretStore();

  if (options.provider === 'gmail') {
    await setupGmail(options, store);
    return;
  }
  if (options.provider === 'outlook') {
    await setupOutlook(options, store);
    return;
  }
  await setupZoho(options, store);
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown OAuth setup failure';
    console.error(`OAuth setup failed: ${message}`);
    process.exitCode = 1;
  });
}
