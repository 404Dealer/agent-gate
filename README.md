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

## Security Model

This isn't "we told the AI to be careful." It's structural:

- **Process isolation** — agent-gate runs as a separate OS user. The AI agent cannot read, modify, or delete drafts after submission.
- **Write-only inbox** — the agent can drop files in but cannot read or list the directory (Unix dropbox permissions: `1730`).
- **Hash-verified approvals** — SHA-256 hash is computed at preview time and embedded in the approve button. If the draft is modified between preview and approval, the approval is rejected.
- **From-address enforcement** — the `from` field in drafts is ignored. The configured sender address is always used. Prevents spoofing.
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

providers:
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
│       ├── index.ts      # Provider registry
│       ├── email-zoho.ts # Zoho Mail API
│       └── log-only.ts   # Dry-run logger
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
- ✅ SHA-256 hash-verified approvals
- ✅ Zoho Mail email provider
- ✅ Log-only dry-run provider
- ✅ `${PASS:key}` and `${ENV}` secret resolvers
- ✅ Schema validation with size/count bounds
- ✅ JSON audit logging
- ✅ Symlink/device file rejection
- ✅ From-address enforcement
- ✅ Sanitized error handling

### Planned

- [ ] Edit flow — modify drafts in Telegram before approving
- [ ] Gmail provider
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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](./LICENSE)
