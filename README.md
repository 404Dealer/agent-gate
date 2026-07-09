# agent-gate

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)

Deterministic approval layer between AI agents and external actions.

**Agents propose. Humans approve. Scripts execute.** No AI in the execution path.

## The Problem

AI agents with email and API access are a prompt injection timebomb. Current mitigations:

- **"Trust the system prompt"** — behavioral, not structural. Fails under injection.
- **"Restrict the agent's tools"** — if it can draft AND confirm, it can still send anything.
- **"Remove access entirely"** — then what's the point of having an agent?

agent-gate enforces a **structural** control plane that no amount of prompt injection can bypass.

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
2. agent-gate picks it up and sends a preview to your Telegram.
3. You tap **Approve** or **Deny**.
4. If approved, a deterministic script executes exactly what you reviewed — no AI involved.

## Requirements for the Security Model to Hold

agent-gate is only a **hard security boundary** when these requirements are true:

| Requirement | Why it matters |
|-------------|----------------|
| agent-gate runs as a separate OS user | Prevents the AI agent process from reading/modifying pending or approved drafts |
| The agent has write-only access to the inbox | The agent can propose drafts but cannot list, read, edit, delete, or replace drafts after submission |
| Send credentials live only in agent-gate | If the agent also has SMTP/Gmail/Zoho send credentials, it can bypass the gate |
| The approval bot token is not available to the agent | Prevents the agent from approving its own drafts |
| `security.enforceProductionPermissions: true` in production | Fails closed if the write-only inbox/private state directories are misconfigured |
| Humans review the actual outbound payload | The approval decision is about the concrete email/webhook body, recipients, provider, and context |

If you run agent-gate and your agent as the same Unix user, or give the agent direct send credentials, agent-gate is still useful as an approval workflow — but it is **not** a structural security boundary.

See [docs/deployment.md](docs/deployment.md) for the production filesystem setup, [docs/hermes.md](docs/hermes.md) for Hermes-specific integration, and [docs/credential-handoff.md](docs/credential-handoff.md) for the operator responsibilities and secret handoff flow.

## How This Differs from Hermes Built-In Approval

Hermes Agent already has useful approval controls for tool and command risk. agent-gate is complementary, not a replacement.

| Capability | Hermes built-in approval | agent-gate |
|------------|--------------------------|------------|
| Primary approval target | Tool calls / shell commands | Exact outbound payloads |
| Typical question | “Should this command/tool run?” | “Should this exact email/webhook be sent?” |
| Final executor | Hermes tool runtime | Separate deterministic service |
| Send credentials | May live in Hermes if configured | Live only in agent-gate |
| Best for | Dangerous local commands, tool use, operational actions | Email, replies, webhooks, API calls, external side effects |
| Security shape | Tool-level/behavioral approval | Payload-level structural boundary |

For example, Hermes approval can help decide whether a risky command should run. agent-gate is for a different problem: Hermes drafts an email, but a separate process with separate credentials sends only the exact payload a human approved.

## Security Model

This isn't "we told the AI to be careful." It's structural:

- **Process isolation** — agent-gate runs as a separate OS user. The AI agent cannot read, modify, or delete drafts after submission.
- **Write-only inbox** — the agent can drop files in but cannot read or list the directory (Unix dropbox permissions: `1730`).
- **Hash-verified approvals** — a full SHA-256 hash is computed at preview time and bound to an unguessable approval nonce. If the draft is modified between preview and approval, the approval is rejected.
- **From-address enforcement** — the `from` field in drafts is ignored. The approval preview shows the configured sender address and labels the draft `from` as ignored, preventing approval-screen spoofing.
- **No AI in execution** — the executor reads the approved file directly. No LLM processes, summarizes, or touches the content.
- **Out-of-band approval** — the Telegram bot has its own token and runs independently. The AI agent has no access to it.
- **Schema validation** — [Zod](https://zod.dev) schemas enforce bounds on all fields (subject: 500 chars, body: 256KB, tags: 20 max).
- **Symlink rejection** — only regular files are accepted via `lstat()`. Symlinks, devices, sockets, and directories are rejected.
- **Sanitized errors** — no raw API responses or stack traces leak to Telegram or audit logs.

## Quick Start

```bash
git clone https://github.com/404Dealer/agent-gate.git
cd agent-gate
npm install
cp config.example.yaml config.yaml
# Edit config.yaml with your bot token and provider credentials
npm run build
npm start
```

### Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token into your `config.yaml`
4. Get your Telegram user ID (message [@userinfobot](https://t.me/userinfobot)) and add it to `allowedUsers`
5. Send `/start` to your new bot

### Development Mode

```bash
npm run dev  # Runs with tsx, no build step needed
```

## Integration

If your agent can write a JSON file, it can use agent-gate. No SDK, no API client, no runtime dependency.

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

That's it. agent-gate handles the rest.

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
| `type` | `"email"` \| `"webhook"` | ✅ | Action type |
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
  botToken: "${AGENT_GATE_BOT_TOKEN}"
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
  gmail:
    type: "email-gmail"
    clientId: "${GOOGLE_CLIENT_ID}"
    clientSecret: "${GOOGLE_CLIENT_SECRET}"
    refreshToken: "${GOOGLE_REFRESH_TOKEN}"
    fromAddress: "you@gmail.com"
    displayName: "Your Name"

  zoho:
    type: "email-zoho"
    clientId: "${ZOHO_CLIENT_ID}"
    clientSecret: "${ZOHO_CLIENT_SECRET}"
    refreshToken: "${ZOHO_REFRESH_TOKEN}"
    accountId: "${ZOHO_ACCOUNT_ID}"
    fromAddress: "you@yourdomain.com"

  log:
    type: "log-only"

defaults:
  provider: "log"
  timezone: "UTC"
  autoDeleteAfterDays: 30

audit:
  enabled: true
  logFile: "./audit.log"
```

### Secrets

Config placeholders support two resolvers:

| Syntax | Source | Example |
|--------|--------|---------|
| `${VAR_NAME}` | Environment variable | `${AGENT_GATE_BOT_TOKEN}` |
| `${PASS:path}` | [pass](https://www.passwordstore.org/) (Unix password manager) | `${PASS:agent-gate/bot-token}` |

**Unresolved placeholders cause a hard failure at startup.** No silent empty strings.

## Providers

### `log-only`

Dry-run provider. Logs the payload to stdout, sends nothing. Use for testing and development.

### `email-gmail`

Sends email via the [Gmail API](https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send) using OAuth refresh token flow. The OAuth client needs the `https://www.googleapis.com/auth/gmail.send` scope.

| Config Key | Description |
|------------|-------------|
| `clientId` | Google Cloud OAuth Desktop/Web client ID |
| `clientSecret` | Google Cloud OAuth client secret |
| `refreshToken` | OAuth refresh token with Gmail send scope |
| `fromAddress` | Enforced sender address or configured Gmail send-as alias |
| `displayName` | Optional display name shown in From header |

### `email-zoho`

Sends email via the [Zoho Mail API](https://www.zoho.com/mail/help/api/) using OAuth refresh token flow.

| Config Key | Description |
|------------|-------------|
| `clientId` | Zoho API Console client ID |
| `clientSecret` | Zoho API Console client secret |
| `refreshToken` | Permanent refresh token (`ZohoMail.messages.CREATE` scope) |
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

For maximum isolation, run agent-gate as a dedicated system user:

1. **Create a service user** — no login shell, locked home directory
2. **Set up credentials** — dedicated `pass` store for the service user
3. **Inbox as dropbox** — sticky bit + group write, no read (`1730`)
4. **systemd service** — hardened with `NoNewPrivileges`, `ProtectSystem=strict`, restricted address families
5. **Audit log** — read-only ACL for your main user

See **[docs/deployment.md](docs/deployment.md)** for the complete production hardening guide with copy-paste commands.

## Project Structure

```
agent-gate/
├── src/
│   ├── index.ts          # Entry point
│   ├── config.ts         # Config loader + secret resolution
│   ├── watcher.ts        # File watcher (inbox → pending)
│   ├── bot.ts            # Telegram bot (previews + callbacks)
│   ├── executor.ts       # Reads approved drafts, dispatches to providers
│   ├── schema.ts         # Zod schemas + validation
│   └── providers/
│       ├── index.ts       # Provider registry
│       ├── email-gmail.ts # Gmail API
│       ├── email-zoho.ts  # Zoho Mail API
│       └── log-only.ts    # Dry-run logger
├── drafts/               # Draft queue directories
│   ├── inbox/            # Public dropbox (agents write here)
│   ├── pending/          # Internal (watcher moves files here)
│   ├── approved/         # Human-approved
│   ├── sent/             # Successfully executed
│   ├── denied/           # Human-denied
│   └── failed/           # Validation or send errors
├── docs/
│   └── deployment.md     # Production hardening guide
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
- ✅ Zoho Mail email provider
- ✅ Log-only dry-run provider
- ✅ `${PASS:key}` and `${ENV}` secret resolvers
- ✅ Schema validation with size/count bounds
- ✅ JSON audit logging
- ✅ Symlink/device file rejection
- ✅ From-address enforcement in execution and approval preview
- ✅ Safe long-body preview policy (truncated drafts deny-only by default)
- ✅ Optional production permission checks at startup

### Planned

- [ ] Edit flow — modify drafts in Telegram before approving
- [ ] Generic SMTP provider
- [ ] Webhook provider (for non-email actions: Slack, Discord, APIs)
- [ ] Bulk approve/deny
- [ ] Draft expiry (auto-deny after configurable timeout)
- [ ] Rate limiting / cooldowns
- [ ] Web dashboard for audit trail

## Philosophy

> *"Agents propose, humans approve via out-of-band channel, deterministic scripts execute."*

The agent security space is full of behavioral guardrails — system prompts, content filters, output classifiers. These are valuable but fundamentally brittle: they depend on model compliance, which prompt injection can subvert.

agent-gate takes a different approach: **structural security**. The approval gate is a separate process, running as a separate user, with its own credentials. No amount of prompt injection can make the AI agent approve its own drafts, because the approval channel is physically separated from the agent's runtime.

This is the same principle behind air-gapped networks, hardware security modules, and two-person integrity controls — applied to AI agents.

## AI Agent Skill

The `skill/` directory contains an agent skill (compatible with [OpenClaw](https://openclaw.ai), NanoClaw, and any framework that uses SKILL.md-based skill loading):

```
skill/
├── SKILL.md              # Instructions for the AI agent
└── scripts/
    └── draft-email.sh    # Helper script for drafting emails
```

The skill teaches an AI agent how to write properly-formatted draft files. The agent learns the schema, constraints, and workflow — then uses `sg agentgate-inbox` (or the helper script) to drop drafts into the inbox.

Install the skill in your agent framework, point it at your agent-gate inbox, and your agent can propose emails that you approve via Telegram.

## Hermes Agent Integration

See [docs/hermes.md](docs/hermes.md) for a dedicated Hermes setup guide.

agent-gate is intentionally designed as a Hermes-compatible outbound-action gate:

1. Install this repo's `skill/` directory as a Hermes skill, or keep it in a project and load it for sessions that may draft email.
2. Give Hermes write-only access to `/opt/agent-gate/drafts/inbox` through the `agentgate-inbox` group.
3. Do **not** give Hermes the SMTP/API credentials that agent-gate uses to send. Hermes should read/search/draft; agent-gate should send.
4. For a draft request, Hermes writes JSON only and then tells the user it is pending approval. The approved send happens outside the Hermes process.

That separation is what makes the gate stronger than an agent asking, “Should I send this?” and then calling a send tool itself.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](./LICENSE)
