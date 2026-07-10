import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { updateProviderConfig, validateProviderConfigTarget } from './config-writer.js';
import type { ZohoRegion } from './zoho.js';

export interface SecretStore {
  set(key: string, value: string): Promise<void>;
}

const transactionId = (): string => randomBytes(12).toString('hex');
const versionedKey = (base: string, id: string): string => `agent-gate/${base}-${id}`;
const passReference = (key: string): string => `\${PASS:${key}}`;

const withOnboardingLock = async <T>(configPath: string, operation: () => Promise<T>): Promise<T> => {
  const lockPath = `${configPath}.oauth.lock`;
  let lockHandle: FileHandle;
  try {
    lockHandle = await open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('OAuth onboarding is already in progress for this config');
    }
    throw new Error('Could not acquire the OAuth onboarding lock');
  }

  try {
    await lockHandle.writeFile(`${process.pid}\n`, 'utf8');
    await lockHandle.sync();
    await validateProviderConfigTarget(configPath);
    return await operation();
  } finally {
    await lockHandle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
};

interface PersistGmailOptions {
  configPath: string;
  store: SecretStore;
  clientId: string;
  refreshToken: string;
  email: string;
  displayName?: string;
  setAsDefault: boolean;
}

export async function persistGmailOnboarding(options: PersistGmailOptions): Promise<void> {
  await withOnboardingLock(options.configPath, async () => {
    const id = transactionId();
    const clientIdKey = versionedKey('google-client-id', id);
    const refreshTokenKey = versionedKey('google-refresh-token', id);
    await options.store.set(clientIdKey, options.clientId);
    await options.store.set(refreshTokenKey, options.refreshToken);

    const provider: Record<string, unknown> = {
      type: 'email-gmail',
      clientId: passReference(clientIdKey),
      refreshToken: passReference(refreshTokenKey),
      fromAddress: options.email
    };
    if (options.displayName) provider.displayName = options.displayName;

    await updateProviderConfig(options.configPath, 'gmail', provider, options.setAsDefault);
  });
}

interface PersistOutlookOptions {
  configPath: string;
  store: SecretStore;
  clientId: string;
  refreshToken: string;
  tenantId: string;
  email: string;
  displayName?: string;
  setAsDefault: boolean;
}

export async function persistOutlookOnboarding(options: PersistOutlookOptions): Promise<void> {
  await withOnboardingLock(options.configPath, async () => {
    const id = transactionId();
    const clientIdKey = versionedKey('microsoft-client-id', id);
    const refreshTokenKey = versionedKey('microsoft-refresh-token', id);
    await options.store.set(clientIdKey, options.clientId);
    await options.store.set(refreshTokenKey, options.refreshToken);

    const provider: Record<string, unknown> = {
      type: 'email-outlook',
      clientId: passReference(clientIdKey),
      refreshToken: passReference(refreshTokenKey),
      refreshTokenKey,
      tenantId: options.tenantId,
      fromAddress: options.email
    };
    if (options.displayName) provider.displayName = options.displayName;

    await updateProviderConfig(options.configPath, 'outlook', provider, options.setAsDefault);
  });
}

interface PersistZohoOptions {
  configPath: string;
  store: SecretStore;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  region: ZohoRegion;
  accountId: string;
  email: string;
  displayName?: string;
  setAsDefault: boolean;
}

export async function persistZohoOnboarding(options: PersistZohoOptions): Promise<void> {
  await withOnboardingLock(options.configPath, async () => {
    const id = transactionId();
    const clientIdKey = versionedKey('zoho-client-id', id);
    const clientSecretKey = versionedKey('zoho-client-secret', id);
    const refreshTokenKey = versionedKey('zoho-refresh-token', id);
    await options.store.set(clientIdKey, options.clientId);
    await options.store.set(clientSecretKey, options.clientSecret);
    await options.store.set(refreshTokenKey, options.refreshToken);

    const provider: Record<string, unknown> = {
      type: 'email-zoho',
      clientId: passReference(clientIdKey),
      clientSecret: passReference(clientSecretKey),
      refreshToken: passReference(refreshTokenKey),
      region: options.region,
      accountId: options.accountId,
      fromAddress: options.email
    };
    if (options.displayName) provider.displayName = options.displayName;

    await updateProviderConfig(options.configPath, 'zoho', provider, options.setAsDefault);
  });
}
