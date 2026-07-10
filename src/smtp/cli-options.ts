export interface SmtpSetupOptions {
  provider: 'gmail';
  configPath: string;
}

export function parseSmtpSetupArgs(args: string[]): SmtpSetupOptions {
  const [providerValue, ...rest] = args;
  if (providerValue !== 'gmail') {
    throw new Error('Provider must be gmail');
  }

  let configPath = '/opt/agent-gate/config/config.yaml';
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === '--config') {
      const value = rest[++index];
      if (!value) throw new Error('--config requires a path');
      configPath = value;
      continue;
    }
    throw new Error(`Unknown option: ${option}`);
  }

  return { provider: 'gmail', configPath };
}
