#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { validateProviderConfigTarget } from './oauth/config-writer.js';
import { sanitizeMetadataText } from './oauth/metadata.js';
import { persistSmtpOnboarding } from './oauth/persist.js';
import { promptConfirm, promptHidden, promptText } from './oauth/prompts.js';
import { PassSecretStore } from './oauth/secret-store.js';
import { sanitizeTerminalText } from './oauth/selection.js';
import { parseSmtpSetupArgs } from './smtp/cli-options.js';
import { normalizeGmailAppPassword } from './smtp/normalize.js';
import { verifyGmailSmtpCredentials } from './smtp/verify.js';

const GmailAddressSchema = z.string().email().refine(
  (value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value),
  'Gmail address contains unsafe characters'
);

const usage = (): string => `Usage: agent-gate-smtp-setup gmail [--config PATH]

Interactive Gmail App Password onboarding over authenticated SMTP/TLS.
Run this only through scripts/smtp-setup.sh from a human-controlled SSH/local terminal.
Secrets are never accepted as command-line arguments.`;

async function assertSecureRuntime(configPath: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('SMTP setup requires a human-controlled interactive TTY');
  }
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) {
    throw new Error('SMTP setup must run as the isolated agentgate user, never as root');
  }

  const stat = await lstat(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Agent-gate config must be a regular file, not a symlink');
  }
  if (stat.uid !== uid) {
    throw new Error('Agent-gate config must be owned by the SMTP setup user');
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error('Agent-gate config must have mode 0600 before SMTP setup');
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(usage());
    return;
  }

  const options = parseSmtpSetupArgs(args);
  await assertSecureRuntime(options.configPath);
  await validateProviderConfigTarget(options.configPath);

  console.log('\nGmail App Password SMTP onboarding');
  console.log('Prerequisite: enable Google 2-Step Verification, then create a dedicated App Password.');
  console.log('Google App Passwords: https://myaccount.google.com/apppasswords');
  const emailInput = await promptText('Gmail address');
  const parsedEmail = GmailAddressSchema.safeParse(emailInput);
  if (!parsedEmail.success) throw new Error('A valid Gmail address is required');
  const email = parsedEmail.data;
  const displayName = sanitizeMetadataText(await promptText('Optional sender display name'));
  let password = normalizeGmailAppPassword(await promptHidden('Google App Password (hidden)'));

  try {
    console.log('\nVerifying Gmail SMTP credentials over TLS...');
    await verifyGmailSmtpCredentials(email, password);
    const safeEmail = sanitizeTerminalText(email);
    const setAsDefault = await promptConfirm(`Verified ${safeEmail}. Set Gmail SMTP as the default provider?`);

    await persistSmtpOnboarding({
      configPath: options.configPath,
      store: new PassSecretStore(),
      providerName: 'gmail-smtp',
      host: 'smtp.gmail.com',
      port: 465,
      tlsMode: 'implicit',
      username: email,
      password,
      fromAddress: email,
      displayName: displayName || undefined,
      setAsDefault
    });
    console.log(`\nGmail SMTP onboarding complete for ${safeEmail}. No password value was printed.`);
  } finally {
    password = '';
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown SMTP setup failure';
    console.error(`SMTP setup failed: ${message}`);
    process.exitCode = 1;
  });
}
