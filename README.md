# Nightdrop

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![CI](https://github.com/404Dealer/nightdrop/actions/workflows/ci.yml/badge.svg)](https://github.com/404Dealer/nightdrop/actions/workflows/ci.yml)

Credential-isolated approval layer between AI agents and external actions, with bounded multi-account Gmail/Outlook triage and Telegram-approved send, Trash, and unsubscribe operations.

**Agents propose. Humans approve. Scripts execute.** No AI in the execution path.

## The Problem

AI agents with email and API access are a prompt injection timebomb. Current mitigations:

- **"Trust the system prompt"** — behavioral, not structural. Fails under injection.
- **"Restrict the agent's tools"** — if it can draft AND confirm, it can still send anything.
- **"Remove access entirely"** — then what's the point of having an agent?

When deployed with the isolation requirements below, Nightdrop enforces a **structural** control plane that prompt injection alone cannot bypass.

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  AI Agent    │────▶│  Draft Queue  │────▶│ Telegram Bot  │────▶│  Executor    │
│ (any stack)  │     │ (JSON files)  │     │ (approval UX) │     │ (providers)  │
└─────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
     writes              watches            human reviews         sends/executes
     draft files         for new files      approve / deny        approved drafts
```

1. Your agent writes a JSON draft file to an inbox directory.
2. Nightdrop picks it up and sends a preview to your Telegram.
3. You tap **Approve** or **Deny**.
4. If approved, a deterministic script executes exactly what you reviewed — no AI involved.

## Requirements for the Security Model to Hold

Nightdrop is only a **hard security boundary** when these requirements are true:

| Requirement | Why it matters |
|-------------|----------------|
| Nightdrop runs as a separate OS user | Prevents the AI agent process from reading/modifying pending or approved drafts |
| The agent has write-only access to the inbox | The agent can propose drafts but cannot list, read, edit, delete, or replace drafts after submission |
| Send credentials live only in Nightdrop | If the agent also has SMTP, Gmail, Outlook, or Zoho send credentials, it can bypass the gate |
| The approval bot token is not available to the agent | Prevents the agent from approving its own drafts |
| Gmail/Outlook mailbox access is exposed only through the bounded Unix-socket broker | Keeps Gmail App Passwords, Outlook OAuth tokens, arbitrary IMAP commands, and unrestricted Graph calls outside the agent process |
| `security.enforceProductionPermissions: true` in production | Fails closed if the write-only inbox/private state directories are misconfigured |
| Humans review the actual action | The approval decision is about the concrete email payload or exact mailbox operation shown in Telegram |

If you run Nightdrop and your agent as the same Unix user, or give the agent direct send credentials, Nightdrop is still useful as an approval workflow — but it is **not** a structural security boundary.

See [docs/deployment.md](docs/deployment.md) for the production filesystem setup, [docs/hermes.md](docs/hermes.md) for bounded mailbox and outbound Hermes integration, [docs/credential-handoff.md](docs/credential-handoff.md) for operator responsibilities, [docs/smtp-onboarding.md](docs/smtp-onboarding.md) for simple Gmail App Password setup, [docs/mailbox-cleanup.md](docs/mailbox-cleanup.md) for human-gated Spam/Trash unread cleanup, and [docs/oauth-onboarding.md](docs/oauth-onboarding.md) for narrower OAuth authorization.

## How This Differs from Hermes Built-In Approval

Hermes Agent already has useful approval controls for tool and command risk. Nightdrop is complementary, not a replacement.

| Capability | Hermes built-in approval | Nightdrop |
|------------|--------------------------|------------|
| Primary approval target | Tool calls / shell commands | Exact email payloads and mailbox operations |
| Typical question | “Should this command/tool run?” | “Should this email be sent, or should this exact message be moved or unsubscribed?” |
| Final executor | Hermes tool runtime | Separate deterministic service |
| Send credentials | May live in Hermes if configured | Live only in Nightdrop |
| Best for | Dangerous local commands, tool use, operational actions | Email, replies, and bounded mailbox actions |
| Security shape | Tool-level/behavioral approval | Payload-level structural boundary |

For example, Hermes approval can help decide whether a risky command should run. Nightdrop is for a different problem: Hermes drafts an email, but a separate process with separate credentials sends only the exact payload a human approved.

## Security Model

This isn't "we told the AI to be careful." It's structural:

- **Process isolation** — Nightdrop runs as a separate OS user. The AI agent cannot read, modify, or delete drafts after submission.
- **Write-only inbox** — the agent can drop files in but cannot read or list the directory (Unix dropbox permissions: `1730`).
- **Hash-verified approvals** — a full SHA-256 hash is computed at preview time and bound to an unguessable approval nonce. If the draft is modified between preview and approval, the approval is rejected.
- **From-address enforcement** — the `from` field in drafts is ignored. The approval preview shows the configured sender address and labels the draft `from` as ignored, preventing approval-screen spoofing.
- **No AI in execution** — the executor reads the approved file directly. No LLM processes, summarizes, or touches the content.
- **Out-of-band approval** — the Telegram bot has its own token and runs independently. The AI agent has no access to it.
- **Schema validation** — [Zod](https://zod.dev) schemas enforce bounds on all fields (subject: 500 chars, body: 256KB, tags: 20 max).
- **Symlink rejection** — only regular files are accepted via `lstat()`. Symlinks, devices, sockets, and directories are rejected.
- **Sanitized errors** — no raw API responses or stack traces leak to Telegram or audit logs.

## Quick Start

This path is for local evaluation and development. It does not create the separate-user security boundary described above. Use [docs/deployment.md](docs/deployment.md) and the installed credential-onboarding wrappers for production.

```bash
git clone https://github.com/404Dealer/nightdrop.git
cd nightdrop
npm ci
cp config.example.yaml config.yaml
# Set the environment variables referenced by config.yaml.
npm run build
npm start
```

### Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. For local development, resolve the bot-token placeholder through your environment. For production, use `sudo /opt/nightdrop/scripts/configure-provider-secrets.sh telegram`; do not place a literal token in config.
4. Get your Telegram user ID (message [@userinfobot](https://t.me/userinfobot)) and add it to `allowedUsers`
5. Send `/start` to your new bot

### Development Mode

```bash
npm run dev  # Runs with tsx, no build step needed
```

## Integration

If your agent can write a JSON file, it can use Nightdrop. No SDK, no API client, no runtime dependency.

### Write a Draft

Drop a `.json` file into the configured inbox directory:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "email",
  "status": "pending",
  "createdAt": "2026-01-15T10:30:00Z",
  "updatedAt": "2026-01-15T10:30:00Z",
  "source": "my-agent",
  "provider": "zoho",
  "payload": {
    "from": "ignored@example.com",
    "to": "recipient@example.com",
    "subject": "Follow-up on our conversation",
    "body": "<p>Hi, just following up on our meeting yesterday.</p>"
  },
  "metadata": {
    "context": "User asked me to follow up after yesterday's call",
    "priority": "normal",
    "tags": ["follow-up"]
  }
}
```

That's it. Nightdrop handles the rest.

### Works With Any Framework

| Framework | Integration |
|-----------|------------|
| [OpenClaw](https://openclaw.ai) | Write draft file from agent session |
| LangChain | Custom tool that writes JSON |
| AutoGen | Function call that drops a file |
| Claude Code / Codex | Shell command to write JSON |
| Bash scripts | `cat > drafts/inbox/draft.json << 'EOF'` |
| **Anything else** | If it can write a file, it works |

### Draft Schema

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID string | ✅ | Unique draft identifier |
| `type` | `"email"` \| `"webhook"` | ✅ | `webhook` is schema-reserved; no executing webhook provider ships yet |
| `status` | `"pending"` | ✅ | Must be `"pending"` for new drafts |
| `createdAt` | ISO 8601 | ✅ | |
| `updatedAt` | ISO 8601 | ✅ | |
| `source` | string | ✅ | Identifies which agent/system created this |
| `provider` | string | ✅ | Provider key from your config |
| `payload` | object | ✅ | Provider-specific (see below) |
| `metadata.context` | string | | Why the agent drafted this (shown in preview) |
| `metadata.priority` | string | | `"normal"`, `"high"`, etc. |
| `metadata.tags` | string[] | | Up to 20 tags |

#### Email Payload

| Field | Type | Required | Limits |
|-------|------|----------|--------|
| `to` | string or string[] | ✅ | Valid email(s) |
| `subject` | string | ✅ | Max 500 chars |
| `body` | string | ✅ | Max 256KB, HTML supported |
| `cc` | string[] | | |
| `bcc` | string[] | | |
| `replyTo` | string | | |

> **Note:** The `from` field is accepted but ignored — the configured `fromAddress` on the provider is always used.

**Status flow:** `pending` → `approved` / `denied` → `sent` / `failed`

## Configuration

```yaml
telegram:
  botToken: "${NIGHTDROP_BOT_TOKEN}"
  allowedUsers: [123456789]  # Your Telegram user ID(s)

watch:
  directory: "./drafts/inbox"
  pollIntervalMs: 2000

approval:
  bodyPreviewChars: 2000        # Long bodies are truncated in Telegram previews
  allowTruncatedApproval: false # Safer default: truncated drafts show Deny only

security:
  enforceProductionPermissions: false # Set true after applying docs/deployment.md

providers:
  gmail-smtp:
    type: "email-smtp"
    host: "smtp.gmail.com"
    port: 465
    tlsMode: "implicit"
    username: "you@gmail.com"
    password: "${NIGHTDROP_GMAIL_APP_PASSWORD}"
    fromAddress: "you@gmail.com"
    displayName: "Your Name"

  gmail:
    type: "email-gmail"
    clientId: "${NIGHTDROP_GOOGLE_CLIENT_ID}"
    # Desktop/public-client OAuth does not use clientSecret.
    refreshToken: "${NIGHTDROP_GOOGLE_REFRESH_TOKEN}"
    fromAddress: "you@gmail.com"
    displayName: "Your Name"

  outlook:
    type: "email-outlook"
    clientId: "${NIGHTDROP_MICROSOFT_CLIENT_ID}"
    # Omit clientSecret for public-client PKCE/device flows.
    refreshToken: "${NIGHTDROP_MICROSOFT_REFRESH_TOKEN}"
    tenantId: "common"
    fromAddress: "you@outlook.com"
    displayName: "Your Name"

  zoho:
    type: "email-zoho"
    clientId: "${NIGHTDROP_ZOHO_CLIENT_ID}"
    clientSecret: "${NIGHTDROP_ZOHO_CLIENT_SECRET}"
    refreshToken: "${NIGHTDROP_ZOHO_REFRESH_TOKEN}"
    region: "us"
    accountId: "${NIGHTDROP_ZOHO_ACCOUNT_ID}"
    fromAddress: "you@yourdomain.com"

  log:
    type: "log-only"

mailboxProfiles:
  personal:
    provider: gmail-smtp

defaults:
  provider: "log"
  timezone: "UTC"
  autoDeleteAfterDays: 30

audit:
  enabled: true
  logFile: "./audit.log"
```

Each mailbox profile maps one account to one provider. The base `outlook` provider above is send-only. A manually configured named Outlook mailbox is an explicit opt-in:

```yaml
providers:
  outlook-work:
    type: "email-outlook"
    clientId: "${NIGHTDROP_MICROSOFT_WORK_CLIENT_ID}"
    refreshToken: "${NIGHTDROP_MICROSOFT_WORK_REFRESH_TOKEN}"
    tenantId: "common"
    fromAddress: "you@outlook.com"
    mailboxAccess: true # Requires delegated Mail.ReadWrite.

mailboxProfiles:
  work:
    provider: outlook-work
```

For production, run `sudo /opt/nightdrop/scripts/oauth-setup.sh outlook --profile work`. The installed helper requests the required mailbox scope and creates the provider/profile binding atomically; you do not need to edit private production config by hand.

### Secrets

Config placeholders support two resolvers:

| Syntax | Source | Example |
|--------|--------|---------|
| `${NIGHTDROP_VAR_NAME}` | Environment variable | `${NIGHTDROP_BOT_TOKEN}` |
| `${PASS:path}` | [pass](https://www.passwordstore.org/) (Unix password manager) | `${PASS:nightdrop/bot-token}` |

**Unresolved placeholders cause a hard failure at startup.** No silent empty strings.

### Simple Gmail App Password onboarding

For the Himalaya-style self-hosted path, no Google Cloud project or OAuth client is required:

```bash
# Human-controlled terminal only
sudo /opt/nightdrop/scripts/configure-provider-secrets.sh telegram
# Existing one-account compatibility setup:
sudo /opt/nightdrop/scripts/smtp-setup.sh gmail
# Or create a named Gmail mailbox (repeat with a unique profile per account):
sudo /opt/nightdrop/scripts/smtp-setup.sh gmail --profile personal
```

The SMTP helper verifies Gmail over TLS, stores the App Password directly under `nightdrop`, writes only a versioned `${PASS:...}` reference to private config, and restarts the service. App Passwords are simpler but broader than the Gmail API `gmail.send` scope. See **[docs/smtp-onboarding.md](docs/smtp-onboarding.md)** for prerequisites, revocation, and exact behavior.

### Human-gated Spam/Trash unread cleanup

After Gmail SMTP onboarding, an operator can clear unread badges in Gmail's Spam and Trash folders without exposing mailbox credentials to Hermes:

```bash
sudo /opt/nightdrop/scripts/mailbox-cleanup.sh gmail
```

The helper previews counts, requires the exact phrase `MARK READ`, and adds only `\Seen` to the snapshotted unread UIDs. It never deletes, moves, empties, or displays messages. See **[docs/mailbox-cleanup.md](docs/mailbox-cleanup.md)** for UID snapshot semantics, auditing, partial outcomes, and troubleshooting.

### Bounded Gmail and Outlook Inbox profiles for Hermes

The production installer exposes one fixed Unix-socket client without giving Hermes Gmail App Passwords, Microsoft refresh tokens, arbitrary IMAP, or arbitrary Graph access:

```bash
/usr/local/bin/nightdrop-mailbox profiles
/usr/local/bin/nightdrop-mailbox list --profile personal --unread --limit 20
/usr/local/bin/nightdrop-mailbox list --profile work --unread --limit 20
/usr/local/bin/nightdrop-mailbox read MESSAGE_REF
/usr/local/bin/nightdrop-mailbox mark-read MESSAGE_REF [MESSAGE_REF ...]
/usr/local/bin/nightdrop-mailbox propose-trash MESSAGE_REF [MESSAGE_REF ...] --context 'Why these messages are unwanted'
/usr/local/bin/nightdrop-mailbox propose-unsubscribe MESSAGE_REF --context 'Why this subscription should stop'
```

Each named profile points to one Gmail SMTP/App Password provider or one Outlook provider. With one configured profile, `list` may omit `--profile`; with multiple profiles it must select one explicitly. Returned opaque references bind the profile and backend, so `read`, `mark-read`, Trash, and unsubscribe route back to the same account. Gmail references bind `UIDVALIDITY + UID`; Outlook references use Graph immutable message IDs. Legacy Gmail v1 references remain bound only to the unique `gmail-smtp` compatibility provider, whether that provider is exposed as implicit `default` or explicitly named; all other named Gmail providers reject them. Reading does not mark mail read. Mark-read affects at most 20 exact references. Mixed-profile bulk requests fail closed. Trash moves and unsubscribe requests require hash-bound Telegram approval.

Unsubscribe uses only authoritative `List-Unsubscribe` headers: RFC 8058 HTTPS one-click is preferred, with a strict RFC 2369 unsubscribe email fallback. It never follows links from the message body. HTTPS redirects, cookies, private-network targets, and caller-supplied URLs are unavailable. Permanent deletion and EXPUNGE remain unavailable.

### Secure OAuth onboarding

A production installation can acquire provider refresh tokens without giving them to Hermes:

```bash
# Human-controlled terminal only
sudo /opt/nightdrop/scripts/configure-provider-secrets.sh telegram
# Then authorize one email provider:
sudo /opt/nightdrop/scripts/oauth-setup.sh gmail
sudo /opt/nightdrop/scripts/oauth-setup.sh outlook
sudo /opt/nightdrop/scripts/oauth-setup.sh outlook --profile work  # bounded Inbox + send
sudo /opt/nightdrop/scripts/oauth-setup.sh zoho
```

The approval-bot token must exist first because the OAuth wrapper restarts the service after a successful commit. The helper drops privileges to `nightdrop` with a clean environment, uses state-bound PKCE browser authorization, writes tokens directly to the encrypted password store, atomically updates private config with versioned `${PASS:...}` references, and restarts the service. Gmail, Outlook, and Zoho use SSH-forwarded loopback callbacks by default. Outlook device authorization is available only as an explicit `--device-code` fallback.

See **[docs/oauth-onboarding.md](docs/oauth-onboarding.md)** for provider registration and exact commands.

## Providers

### `log-only`

Dry-run provider. Logs the payload to stdout, sends nothing. Use for testing and development.

### `email-smtp`

Sends through an authenticated SMTP server with mandatory certificate-verified TLS. Use `tlsMode: implicit` for TLS from connection start (commonly port 465) or `tlsMode: starttls` for a required STARTTLS upgrade (commonly port 587). Unencrypted SMTP is not supported.

| Config Key | Description |
|------------|-------------|
| `host` | SMTP DNS name or IP address |
| `port` | SMTP port (`1`–`65535`) |
| `tlsMode` | `implicit` or `starttls` |
| `username` | SMTP authentication username |
| `password` | SMTP/App Password; use a `${PASS:...}` reference in production |
| `fromAddress` | Enforced sender address; draft `from` is ignored. Must match `username` by default. |
| `allowFromAlias` | Optional explicit opt-in for an operator-verified sender alias or non-email SMTP username; default `false` |
| `displayName` | Optional display name shown in approval preview and From header |

The transport uses fixed connection/greeting/socket timeouts, disables file and URL access, and redacts provider errors. Partial SMTP acceptance is archived as non-retryable `sent` state, recorded as `partial` in audit, and shown to the operator as an explicit Telegram warning with accepted/rejected counts and safe rejected addresses. If SMTP accepts delivery but local archive/audit finalization fails, Telegram instead reports that delivery was accepted with a record warning and instructs the operator not to retry. These states prevent duplicate delivery to already accepted recipients.

### `email-gmail`

Sends email via the [Gmail API](https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send) using OAuth refresh token flow. The OAuth client needs the `https://www.googleapis.com/auth/gmail.send` scope.

| Config Key | Description |
|------------|-------------|
| `clientId` | Google Cloud OAuth client ID; Desktop client recommended |
| `clientSecret` | Optional legacy/confidential-client secret; omitted by secure Desktop onboarding |
| `refreshToken` | OAuth refresh token with Gmail send scope |
| `fromAddress` | Enforced sender address or configured Gmail send-as alias |
| `displayName` | Optional display name shown in From header |

### `email-outlook`

Sends email via [Microsoft Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail) using Microsoft Entra OAuth refresh token flow. Send-only onboarding requests delegated `offline_access`, `Mail.Send`, and onboarding-only `User.Read`. Named mailbox-profile onboarding also requests `Mail.ReadWrite` for the bounded Inbox adapter.

| Config Key | Description |
|------------|-------------|
| `clientId` | Microsoft Entra app/client ID |
| `clientSecret` | Optional confidential-client secret; omitted for recommended public-client PKCE/device flows |
| `refreshToken` | OAuth refresh token with `offline_access Mail.Send` |
| `refreshTokenKey` | Password-store key used to persist Microsoft token rotation; when set, `refreshToken` must be the exact matching `${PASS:key}` reference. Legacy env/literal configs may omit it and rotate only in memory until restart. |
| `tenantId` | Tenant ID, or `common` for personal/multi-tenant auth |
| `userId` | Optional mailbox/user id; omitted uses `/me/sendMail` |
| `fromAddress` | Enforced sender address shown in approval preview |
| `displayName` | Optional display name shown in approval preview |
| `mailboxAccess` | Set by named Outlook mailbox onboarding; requires delegated `Mail.ReadWrite` and enables only the bounded Inbox adapter |

### `email-zoho`

Sends email via the [Zoho Mail API](https://www.zoho.com/mail/help/api/) using OAuth refresh token flow.

| Config Key | Description |
|------------|-------------|
| `clientId` | Zoho API Console client ID |
| `clientSecret` | Zoho API Console client secret |
| `refreshToken` | Long-lived refresh token (`ZohoMail.messages.CREATE` scope) |
| `region` | Pinned Zoho data center: `us`, `eu`, `in`, `au`, `jp`, `ca`, or `sa` (default `us`) |
| `accountId` | Zoho account ID |
| `fromAddress` | Enforced sender address (overrides draft `from`) |

### Writing a Provider

Implement the `Provider` interface and register it:

```typescript
// src/providers/my-provider.ts
import type { Draft } from '../schema.js';
import type { Provider, ProviderResult } from './index.js';

export class MyProvider implements Provider {
  async send(draft: Draft): Promise<ProviderResult> {
    // Send the draft however you want
    return { details: 'Sent via my service' };
  }
}
```

Register in `src/providers/index.ts`. PRs for new providers welcome.

## Telegram UX

When a draft arrives:

```
📧 New Email Draft

From: you@yourdomain.com
To: recipient@example.com
Subject: Follow-up on our conversation

─────────────
Hi, just following up on our meeting yesterday.
─────────────

Source: my-agent
Context: User asked me to follow up
Priority: normal

[✅ Approve]  [❌ Deny]
```

- **Approve** → hash verified → executed → `✅ APPROVED at 3:45 PM`
- **Deny** → draft archived → `❌ DENIED at 3:45 PM`

If the draft was modified after the preview was sent, approval is rejected with a warning.

## Production Deployment

For maximum isolation, run Nightdrop as a dedicated system user:

1. **Create a service user** — no login shell, locked home directory
2. **Set up credentials** — dedicated `pass` store for the service user
3. **Inbox as dropbox** — sticky bit + group write, no read (`1730`)
4. **systemd service** — hardened with `NoNewPrivileges`, `ProtectSystem=strict`, restricted address families
5. **Audit log** — private by default; an operator may explicitly grant a read-only ACL with `--grant-agent-audit-read`

See **[docs/deployment.md](docs/deployment.md)** for the complete production hardening guide with copy-paste commands.

## Project Structure

```
nightdrop/
├── src/
│   ├── index.ts          # Entry point
│   ├── config.ts         # Config loader + secret resolution
│   ├── oauth-setup.ts    # Human-only PKCE OAuth CLI (device fallback for Outlook)
│   ├── oauth/            # PKCE, callback, provider OAuth, secure persistence
│   ├── watcher.ts        # File watcher (inbox → pending)
│   ├── bot.ts            # Telegram bot (previews + callbacks)
│   ├── executor.ts       # Reads approved drafts, dispatches to providers
│   ├── schema.ts         # Zod schemas + validation
│   ├── mailbox-broker/   # Named Gmail/Outlook INBOX, Trash, and unsubscribe broker
│   └── providers/
│       ├── index.ts                 # Provider registry
│       ├── email-smtp.ts            # Authenticated SMTP / Gmail App Passwords
│       ├── email-gmail.ts           # Gmail API
│       ├── email-outlook.ts         # Microsoft Graph sendMail
│       ├── outlook-token-client.ts  # Shared Microsoft token rotation and Graph client
│       ├── email-zoho.ts            # Zoho Mail API
│       └── log-only.ts              # Dry-run logger
├── drafts/               # Draft queue directories
│   ├── inbox/            # Public dropbox (agents write here)
│   ├── pending/          # Internal (watcher moves files here)
│   ├── approved/         # Human-approved
│   ├── sent/             # Successfully executed
│   ├── denied/           # Human-denied
│   └── failed/           # Validation or send errors
├── docs/
│   ├── credential-handoff.md # Operator and agent credential boundaries
│   ├── deployment.md         # Production hardening guide
│   ├── hermes.md             # Hermes mailbox and approval workflow
│   ├── mailbox-cleanup.md    # Gmail Spam/Trash unread cleanup
│   ├── oauth-onboarding.md   # Gmail, Outlook, and Zoho OAuth setup
│   └── smtp-onboarding.md    # Gmail App Password setup
├── config.example.yaml
├── package.json
├── tsconfig.json
└── LICENSE
```

## Roadmap

### Shipped

- ✅ File-based draft queue (inbox → pending → approved → sent)
- ✅ Telegram bot with inline approve/deny buttons
- ✅ SHA-256 hash-verified approvals with nonce-bound callbacks
- ✅ Gmail email provider
- ✅ Authenticated TLS SMTP provider and Gmail App Password onboarding
- ✅ Outlook / Microsoft Graph email provider
- ✅ Zoho Mail email provider
- ✅ Direct-to-`nightdrop` browser/device OAuth onboarding for Gmail, Outlook, and Zoho
- ✅ Log-only dry-run provider
- ✅ `${PASS:key}` and `${NIGHTDROP_*}` secret resolvers
- ✅ Schema validation with size/count bounds
- ✅ JSON audit logging
- ✅ Symlink/device file rejection
- ✅ From-address enforcement in execution and approval preview
- ✅ Safe long-body preview policy (truncated drafts deny-only by default)
- ✅ Optional production permission checks at startup
- ✅ Credential-isolated named Gmail/Outlook Inbox list/read/mark-read broker for Hermes
- ✅ Telegram-approved Gmail Trash and Outlook Deleted Items moves with no permanent-delete path
- ✅ Standards-based HTTPS/mailto unsubscribe with no body-link execution
- ✅ Human-confirmed Gmail Spam/Trash unread cleanup with no message deletion or display

### Planned

- [ ] Edit flow — modify drafts in Telegram before approving
- [ ] Webhook provider (for non-email actions: Slack, Discord, APIs)
- [ ] Bulk approve/deny
- [ ] Draft expiry (auto-deny after configurable timeout)
- [ ] Rate limiting / cooldowns
- [ ] Web dashboard for audit trail

## Philosophy

> *"Agents propose, humans approve via out-of-band channel, deterministic scripts execute."*

The agent security space is full of behavioral guardrails — system prompts, content filters, output classifiers. These are valuable but fundamentally brittle: they depend on model compliance, which prompt injection can subvert.

Nightdrop takes a different approach: **structural security**. The approval gate is a separate process, running as a separate user, with its own credentials. When the deployment requirements above hold, prompt injection alone cannot make the AI agent approve its own drafts because the agent cannot access the approval channel or execution credentials.

This is the same principle behind air-gapped networks, hardware security modules, and two-person integrity controls — applied to AI agents.

## AI Agent Skill

The `skill/` directory contains an agent skill (compatible with [OpenClaw](https://openclaw.ai), NanoClaw, and any framework that uses SKILL.md-based skill loading):

```
skill/
├── SKILL.md              # Instructions for the AI agent
└── scripts/
    └── draft-email.sh    # Helper script for drafting emails
```

The skill teaches an AI agent how to write properly-formatted draft files. The agent learns the schema, constraints, and workflow — then uses `sg nightdrop-inbox` (or the helper script) to drop drafts into the inbox.

Install the skill in your agent framework, point it at your Nightdrop inbox, and your agent can propose emails that you approve via Telegram.

## Hermes Agent Integration

See [docs/hermes.md](docs/hermes.md) for a dedicated Hermes setup guide.

Nightdrop is intentionally designed as a Hermes-compatible outbound-action gate:

1. Install this repo's `skill/` directory as a Hermes skill, or keep it in a project and load it for sessions that may draft email.
2. Give Hermes write-only access to `/opt/nightdrop/drafts/inbox` through the `nightdrop-inbox` group.
3. Do **not** give Hermes the SMTP/API credentials that Nightdrop uses to send. Hermes should read/search/draft; Nightdrop should send.
4. For a draft request, Hermes writes JSON only and then tells the user it is pending approval. The approved send happens outside the Hermes process.

That separation is what makes the gate stronger than an agent asking, “Should I send this?” and then calling a send tool itself.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](./LICENSE)
