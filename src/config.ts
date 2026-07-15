import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const TelegramConfigSchema = z.object({
  botToken: z.string().min(1),
  allowedUsers: z.array(z.number().int()).min(1)
});

const PASS_KEY_PATTERN = /^nightdrop\/[a-z0-9][a-z0-9-]*$/;
const ENVIRONMENT_NAME_PATTERN = /^NIGHTDROP_[A-Z0-9_]+$/;

const WatchConfigSchema = z.object({
  directory: z.string().default('./drafts/inbox'),
  pollIntervalMs: z.number().int().positive().default(2000)
});

const ApprovalConfigSchema = z.object({
  bodyPreviewChars: z.number().int().positive().max(12000).default(2000),
  allowTruncatedApproval: z.boolean().default(false)
}).default({});

const SecurityConfigSchema = z.object({
  enforceProductionPermissions: z.boolean().default(false)
}).default({});

const MailboxProfilesSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  z.object({ provider: z.string().min(1) }).strict()
).optional();

const SmtpHostSchema = z.string().min(1).max(253).refine((value) => {
  if (isIP(value) !== 0) return true;
  const host = value.endsWith('.') ? value.slice(0, -1) : value;
  if (!host) return false;
  return host.split('.').every((label) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)
  );
}, 'Invalid SMTP host');

const ProviderSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('log-only'), fromAddress: z.string().email().optional() }),
  z.object({
    type: z.literal('email-smtp'),
    host: SmtpHostSchema,
    port: z.number().int().min(1).max(65535),
    tlsMode: z.enum(['implicit', 'starttls']),
    username: z.string().trim().min(1),
    password: z.string().min(1),
    fromAddress: z.string().email(),
    displayName: z.string().optional(),
    allowFromAlias: z.boolean().default(false)
  }),
  z.object({
    type: z.literal('email-gmail'),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1).optional(),
    refreshToken: z.string().min(1),
    fromAddress: z.string().email(),
    displayName: z.string().optional()
  }),
  z.object({
    type: z.literal('email-zoho'),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    refreshToken: z.string().min(1),
    region: z.enum(['us', 'eu', 'in', 'au', 'jp', 'ca', 'sa']).default('us'),
    accountId: z.string().min(1),
    fromAddress: z.string().email(),
    displayName: z.string().optional()
  }),
  z.object({
    type: z.literal('email-outlook'),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1).optional(),
    refreshToken: z.string().min(1),
    refreshTokenKey: z.string().regex(PASS_KEY_PATTERN).optional(),
    tenantId: z.string().min(1).default('common'),
    userId: z.string().min(1).optional(),
    mailboxAccess: z.boolean().optional(),
    fromAddress: z.string().email(),
    displayName: z.string().optional()
  })
]);

const ConfigSchema = z.object({
  telegram: TelegramConfigSchema,
  watch: WatchConfigSchema,
  approval: ApprovalConfigSchema,
  security: SecurityConfigSchema,
  providers: z.record(ProviderSchema),
  mailboxProfiles: MailboxProfilesSchema,
  defaults: z.object({
    provider: z.string().min(1),
    timezone: z.string().default('UTC'),
    autoDeleteAfterDays: z.number().int().positive().optional()
  }),
  audit: z.object({
    enabled: z.boolean().default(true),
    logFile: z.string().default('./audit.log')
  })
}).superRefine((config, context) => {
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.type !== 'email-smtp' || provider.allowFromAlias) continue;
    if (provider.username.trim().toLowerCase() !== provider.fromAddress.toLowerCase()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providers', name, 'fromAddress'],
        message: 'SMTP fromAddress must match username unless allowFromAlias is explicitly true'
      });
    }
  }
});

export type NightdropConfig = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderSchema>;

function resolvePlaceholder(name: string): string {
  if (name.startsWith('PASS:')) {
    const key = name.slice('PASS:'.length);
    if (!PASS_KEY_PATTERN.test(key)) {
      throw new Error('Pass placeholders must use the nightdrop/* namespace');
    }

    try {
      const passExecutable = process.env.NIGHTDROP_PASS_BIN ?? 'pass';
      if (process.env.NIGHTDROP_PASS_BIN && !isAbsolute(passExecutable)) {
        throw new Error('Configured pass executable must be absolute');
      }
      return execFileSync(passExecutable, ['show', key], { encoding: 'utf8' }).trimEnd();
    } catch {
      throw new Error(`Unresolved placeholder: \${${name}}`);
    }
  }

  if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
    throw new Error('Environment placeholders must use NIGHTDROP_* names');
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

function validateOutlookRefreshTokenBindings(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const providers = (value as Record<string, unknown>).providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return;

  for (const provider of Object.values(providers as Record<string, unknown>)) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue;
    const entry = provider as Record<string, unknown>;
    if (typeof entry.refreshTokenKey !== 'string') continue;
    const expected = `\${PASS:${entry.refreshTokenKey}}`;
    if (entry.refreshToken !== expected) {
      throw new Error('Outlook refreshTokenKey requires refreshToken to use the exact matching ${PASS:key} reference');
    }
  }
}

export async function loadConfig(configPath?: string): Promise<NightdropConfig> {
  const path = resolve(configPath ?? process.env.NIGHTDROP_CONFIG ?? 'config.yaml');
  const raw = await readFile(path, 'utf8');
  const parsed = YAML.parse(raw);
  validateOutlookRefreshTokenBindings(parsed);
  return ConfigSchema.parse(interpolateEnv(parsed));
}
