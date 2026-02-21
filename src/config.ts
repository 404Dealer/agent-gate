import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const TelegramConfigSchema = z.object({
  botToken: z.string().min(1),
  allowedUsers: z.array(z.number().int()).min(1)
});

const WatchConfigSchema = z.object({
  directory: z.string().default('./drafts/inbox'),
  pollIntervalMs: z.number().int().positive().default(2000)
});

const ProviderSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('log-only') }),
  z.object({
    type: z.literal('email-zoho'),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    refreshToken: z.string().min(1),
    accountId: z.string().min(1),
    fromAddress: z.string().email()
  })
]);

const ConfigSchema = z.object({
  telegram: TelegramConfigSchema,
  watch: WatchConfigSchema,
  providers: z.record(ProviderSchema),
  defaults: z.object({
    provider: z.string().min(1),
    timezone: z.string().default('UTC'),
    autoDeleteAfterDays: z.number().int().positive().optional()
  }),
  audit: z.object({
    enabled: z.boolean().default(true),
    logFile: z.string().default('./audit.log')
  })
});

export type AgentGateConfig = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderSchema>;

const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

function resolvePlaceholder(name: string): string {
  if (name.startsWith('PASS:')) {
    const key = name.slice('PASS:'.length);
    if (!key) {
      throw new Error('Missing pass key in ${PASS:key} placeholder');
    }

    try {
      return execSync(`pass show ${shellEscape(key)}`, { encoding: 'utf8' }).trimEnd();
    } catch {
      throw new Error(`Unresolved placeholder: \${${name}}`);
    }
  }

  const envValue = process.env[name];
  if (envValue === undefined) {
    throw new Error(`Unresolved placeholder: \${${name}}`);
  }
  return envValue;
}

function interpolateEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => resolvePlaceholder(name));
  }
  if (Array.isArray(value)) {
    return value.map(interpolateEnv);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateEnv(v);
    }
    return out;
  }
  return value;
}

export async function loadConfig(configPath?: string): Promise<AgentGateConfig> {
  const path = resolve(configPath ?? process.env.AGENT_GATE_CONFIG ?? 'config.yaml');
  const raw = await readFile(path, 'utf8');
  const parsed = YAML.parse(raw);
  return ConfigSchema.parse(interpolateEnv(parsed));
}
