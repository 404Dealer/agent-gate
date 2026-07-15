export interface SmtpSetupOptions {
  provider: 'gmail';
  configPath: string;
  profile?: string;
}

export function parseSmtpSetupArgs(args: string[]): SmtpSetupOptions {
  const [providerValue, ...rest] = args;
  if (providerValue !== 'gmail') {
    throw new Error('Provider must be gmail');
  }

  let configPath = '/opt/nightdrop/config/config.yaml';
  let profile: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === '--config') {
      const value = rest[++index];
      if (!value) throw new Error('--config requires a path');
      configPath = value;
      continue;
    }
    if (option === '--profile') {
      const value = rest[++index];
      if (!value || !/^[a-z][a-z0-9-]{0,31}$/.test(value)) {
        throw new Error('--profile requires a safe profile name');
      }
      profile = value;
      continue;
    }
    throw new Error(`Unknown option: ${option}`);
  }

  return { provider: 'gmail', configPath, ...(profile ? { profile } : {}) };
}
