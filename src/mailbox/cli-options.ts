export interface MailboxCleanupOptions {
  provider: 'gmail';
  configPath: string;
}

export function parseMailboxCleanupArgs(args: string[]): MailboxCleanupOptions {
  const [providerValue, ...rest] = args;
  if (providerValue !== 'gmail') {
    throw new Error('Provider must be gmail');
  }

  let configPath = '/opt/agent-gate/config/config.yaml';
  let configSeen = false;
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === '--config') {
      if (configSeen) throw new Error('--config may be provided only once');
      const value = rest[++index];
      if (!value) throw new Error('--config requires a path');
      configPath = value;
      configSeen = true;
      continue;
    }
    throw new Error('Unknown option');
  }

  return { provider: 'gmail', configPath };
}
