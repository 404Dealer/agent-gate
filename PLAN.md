# agent-gate — Deterministic Approval Layer for AI Agents

## What It Is
A standalone tool that sits between AI agents and external actions (email, API calls, etc.). Agents draft, humans approve via Telegram, deterministic scripts execute. No AI in the execution path.

## The Problem
AI agents with email/API access are a prompt injection timebomb. Current solutions:
- "Trust the system prompt" — behavioral, not structural
- "Restrict the agent's tools" — if it can draft AND confirm, it can still send anything
- "Remove access entirely" — then what's the point?

## The Three-Layer Pattern
1. **Inbound Containment** — isolated reader agents with restricted tool access, sessions destroyed after each run
2. **Outbound Approval** — agents draft actions but cannot execute. Drafts route to a Telegram bot the agent can't access. Human reviews exact content with Approve/Edit/Deny buttons.
3. **Deterministic Execution** — approved actions executed by a script that reads the approved draft directly. No AI in the send path.

**Core principle:** Agents propose. Humans approve via out-of-band channel. Scripts execute exactly what was approved.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  AI Agent    │────▶│  Draft Queue  │────▶│ Telegram Bot  │────▶│  Executor    │
│ (any framework)│  │ (JSON files)  │     │ (standalone)  │     │ (pluggable)  │
└─────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
     writes              watches            human reviews         sends/executes
     draft files         for new drafts     Approve/Edit/Deny    approved actions
```

## Tech Stack
- **Runtime:** Node.js + TypeScript
- **Bot:** grammy (Telegram Bot framework — lightweight, TS-native)
- **Queue:** File-based (JSON drafts in a watched directory) — zero dependencies
- **Executors:** Pluggable — ship with email (Zoho, Gmail, SMTP), webhooks. Easy to add more.
- **Config:** Single YAML/JSON config file

## Directory Structure

```
agent-gate/
├── src/
│   ├── index.ts              # Entry point — starts watcher + bot
│   ├── watcher.ts            # Watches drafts/ dir for new .json files
│   ├── bot.ts                # Telegram bot — sends previews, handles callbacks
│   ├── executor.ts           # Reads approved draft, dispatches to provider
│   ├── schema.ts             # Draft file schema + validation (zod)
│   ├── config.ts             # Config loader
│   └── providers/
│       ├── index.ts          # Provider registry
│       ├── email-zoho.ts     # Zoho Mail API executor
│       ├── email-smtp.ts     # Generic SMTP executor
│       ├── email-gmail.ts    # Gmail API executor
│       ├── webhook.ts        # Generic webhook executor
│       └── log-only.ts       # Dry-run / audit-only (no send)
├── drafts/                   # Watched directory
│   ├── pending/              # New drafts land here
│   ├── approved/             # Human-approved, awaiting execution
│   ├── sent/                 # Successfully executed
│   └── denied/               # Human-denied
├── config.example.yaml       # Example config
├── package.json
├── tsconfig.json
├── README.md                 # Full docs + the philosophy
├── LICENSE                   # MIT
└── .github/
    └── workflows/
        └── ci.yml            # Lint + type check + test
```

## Draft Schema (JSON)

```json
{
  "id": "uuid",
  "type": "email",
  "status": "pending",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "source": "agent-name or identifier",
  "provider": "zoho",
  "payload": {
    "from": "engineer@johnnyr.dev",
    "to": "recipient@example.com",
    "subject": "Subject line",
    "body": "HTML or plain text content",
    "cc": [],
    "bcc": [],
    "replyTo": ""
  },
  "metadata": {
    "context": "Why the agent drafted this",
    "priority": "normal",
    "tags": ["job-application", "follow-up"]
  },
  "approval": {
    "approvedBy": null,
    "approvedAt": null,
    "telegramMessageId": null,
    "edits": []
  }
}
```

Status flow: `pending` → `approved` / `denied` / `edited` → `sent` / `failed`

## Telegram Bot UX

When a new draft appears:
```
📧 New Email Draft

From: engineer@johnnyr.dev
To: recipient@example.com
Subject: Follow-up on our conversation

---
[preview of body, truncated if long]
---

Source: main-agent
Context: Following up on Pete's tweet about agent security
Priority: normal

[✅ Approve]  [✏️ Edit]  [❌ Deny]
```

- **Approve** → moves to approved/, executor sends, moves to sent/
- **Edit** → bot asks for changes, updates draft, re-presents for approval
- **Deny** → moves to denied/ with reason

## Config (YAML)

```yaml
telegram:
  botToken: "${AGENT_GATE_BOT_TOKEN}"
  allowedUsers: [2061243435]  # Only these Telegram user IDs can approve

watch:
  directory: "./drafts/pending"
  pollIntervalMs: 2000

providers:
  zoho:
    type: email-zoho
    clientId: "${ZOHO_CLIENT_ID}"
    clientSecret: "${ZOHO_CLIENT_SECRET}"
    refreshToken: "${ZOHO_REFRESH_TOKEN}"
    accountId: "${ZOHO_ACCOUNT_ID}"
  
  gmail:
    type: email-gmail
    credentialsPath: "./gmail-credentials.json"
  
  webhook:
    type: webhook
    url: "https://example.com/hook"
    headers:
      Authorization: "Bearer ${WEBHOOK_TOKEN}"

defaults:
  provider: zoho
  autoDeleteAfterDays: 30

audit:
  enabled: true
  logFile: "./audit.log"
```

## Phase 1 — Foundation (This Sprint)
1. Project scaffolding (package.json, tsconfig, eslint)
2. Draft schema + validation (zod)
3. File watcher (chokidar or fs.watch)
4. Telegram bot with grammy — preview + Approve/Deny buttons
5. Zoho email executor (we already have the pattern from Johnny's setup)
6. Config loader (YAML + env var interpolation)
7. CLI entry point (`npx agent-gate` or `agent-gate start`)
8. README with the philosophy + quickstart
9. CI pipeline (GitHub Actions)
10. First real test: wire it into Johnny's OpenClaw setup

## Phase 2 — Polish
- Edit flow (inline edits via Telegram)
- Gmail provider
- Generic SMTP provider
- Webhook provider (for non-email actions)
- Audit log viewer
- Rate limiting / cooldowns
- Draft expiry (auto-deny after X hours)
- Bulk approve/deny

## Phase 3 — Skill
- OpenClaw skill wrapper (SKILL.md + setup script)
- Skill teaches agent how to write drafts in the right format
- Auto-install agent-gate as a service
- Publish to ClewHub

## What Makes This Different
- **Structural, not behavioral** — the approval gate is a separate process the agent literally cannot bypass
- **Out-of-band approval** — Telegram bot has its own token, runs independently
- **Zero AI in execution** — script reads file, sends exactly what's in it
- **Framework-agnostic** — works with OpenClaw, LangChain, AutoGPT, raw scripts, anything that can write a JSON file
- **File-based queue** — no database, no Redis, no complexity. JSON files in directories.
- **Pluggable providers** — email today, Slack messages tomorrow, API calls next week
