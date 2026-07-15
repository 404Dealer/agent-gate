import type { NightdropConfig, ProviderConfig } from '../config.js';
import type { BrokerCredentials } from './gmail-inbox.js';

export const MAILBOX_PROFILE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

interface MailboxProfileBase {
  name: string;
  providerName: string;
  address: string;
}

export interface GmailMailboxProfile extends MailboxProfileBase {
  backend: 'gmail';
  credentials: BrokerCredentials;
  providerConfig: Extract<ProviderConfig, { type: 'email-smtp' }>;
}

export interface OutlookMailboxProfile extends MailboxProfileBase {
  backend: 'outlook';
  providerConfig: Extract<ProviderConfig, { type: 'email-outlook' }>;
}

export type MailboxProfile = GmailMailboxProfile | OutlookMailboxProfile;

export function isEligibleGmailMailboxProvider(
  provider: ProviderConfig | undefined
): provider is Extract<ProviderConfig, { type: 'email-smtp' }> {
  return !!provider &&
    provider.type === 'email-smtp' &&
    provider.host === 'smtp.gmail.com' &&
    provider.port === 465 &&
    provider.tlsMode === 'implicit' &&
    provider.allowFromAlias === false &&
    provider.username.trim().toLowerCase() === provider.fromAddress.toLowerCase();
}

const toProfile = (
  name: string,
  providerName: string,
  provider: ProviderConfig | undefined
): MailboxProfile => {
  if (!MAILBOX_PROFILE_PATTERN.test(name)) throw new Error(`Invalid mailbox profile: ${name}`);
  if (isEligibleGmailMailboxProvider(provider)) {
    return {
      name,
      providerName,
      backend: 'gmail',
      address: provider.fromAddress,
      credentials: { username: provider.username, password: provider.password },
      providerConfig: provider
    };
  }
  if (provider?.type === 'email-outlook' && provider.mailboxAccess === true) {
    return {
      name,
      providerName,
      backend: 'outlook',
      address: provider.fromAddress,
      providerConfig: provider
    };
  }
  throw new Error(`Mailbox profile provider is not supported: ${providerName}`);
};

export function mailboxProfilesFromConfig(config: NightdropConfig): Map<string, MailboxProfile> {
  const configured = config.mailboxProfiles ?? {};
  const entries = Object.entries(configured);
  const selected = entries.map(([name, value]) => [name, value.provider] as const);
  const legacyGmail = config.providers['gmail-smtp'];
  if (isEligibleGmailMailboxProvider(legacyGmail)) {
    const explicitAddresses = new Set(selected.map(([, providerName]) => {
      const provider = config.providers[providerName];
      return provider && 'fromAddress' in provider && typeof provider.fromAddress === 'string'
        ? provider.fromAddress.toLowerCase()
        : '';
    }));
    const hasDefaultName = selected.some(([name]) => name === 'default');
    if (!hasDefaultName && !explicitAddresses.has(legacyGmail.fromAddress.toLowerCase())) {
      selected.push(['default', 'gmail-smtp'] as const);
    }
  }

  const profiles = selected
    .map(([name, providerName]) => toProfile(name, providerName, config.providers[providerName]))
    .sort((a, b) => a.name.localeCompare(b.name));

  const addresses = new Set<string>();
  for (const profile of profiles) {
    const address = profile.address.toLowerCase();
    if (addresses.has(address)) throw new Error('Mailbox profiles must use unique account addresses');
    addresses.add(address);
  }
  return new Map(profiles.map((profile) => [profile.name, profile]));
}
