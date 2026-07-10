export type OAuthSetupProvider = 'gmail' | 'outlook' | 'zoho';

export interface OAuthSetupOptions {
  provider: OAuthSetupProvider;
  configPath: string;
  port: number;
  deviceCode: boolean;
}

export function parseOAuthSetupArgs(args: string[]): OAuthSetupOptions {
  const [providerValue, ...rest] = args;
  if (providerValue !== 'gmail' && providerValue !== 'outlook' && providerValue !== 'zoho') {
    throw new Error('Provider must be one of: gmail, outlook, zoho');
  }

  let configPath = '/opt/agent-gate/config/config.yaml';
  let port = 8765;
  let deviceCode = false;

  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === '--device-code') {
      deviceCode = true;
      continue;
    }
    if (option === '--config') {
      const value = rest[++index];
      if (!value) throw new Error('--config requires a path');
      configPath = value;
      continue;
    }
    if (option === '--port') {
      const value = rest[++index];
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
        throw new Error('--port must be an integer from 1024 to 65535');
      }
      port = parsed;
      continue;
    }
    throw new Error(`Unknown option: ${option}`);
  }

  if (deviceCode && providerValue !== 'outlook') {
    throw new Error('--device-code is only valid for outlook');
  }
  return { provider: providerValue, configPath, port, deviceCode };
}
