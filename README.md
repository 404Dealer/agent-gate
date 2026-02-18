# agent-gate

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Deterministic approval layer between AI agents and external actions (email, webhooks, and beyond).

## Why this exists

Behavioral guardrails fail under prompt injection because they depend on model compliance.
`agent-gate` enforces a **structural** control plane:

1. **Agents propose** actions by writing drafts.
2. **Humans approve** out-of-band in Telegram.
3. **Deterministic code executes** exactly what was approved.

No AI in the final execution path.

## Architecture

```text
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  AI Agent   │────▶│  Draft Queue  │────▶│ Telegram Bot  │────▶│  Executor    │
│ (any stack) │     │ (JSON files)  │     │ (approval UX) │     │ (providers)  │
└─────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

## Quickstart

```bash
git clone <local-or-remote>
cd agent-gate
cp config.example.yaml config.yaml
# fill env vars referenced by config
npm install
npm run dev
```

Or compiled:

```bash
npm run build
npm start
```

## Draft schema (reference)

Each draft is a JSON file in `drafts/pending/*.json`.

Required top-level fields:
- `id` (uuid)
- `type` (`email` | `webhook`)
- `status` (`pending|approved|denied|edited|sent|failed`)
- `createdAt`, `updatedAt` (ISO timestamp)
- `source`
- `provider` (provider key from config)
- `payload`
- `metadata` (`context`, `priority`, `tags`)
- `approval` (`approvedBy`, `approvedAt`, `telegramMessageId`, etc.)

## Providers

### `log-only`
Default safe provider. Logs what would happen, sends nothing.

### `email-zoho`
Uses Zoho OAuth refresh token flow and sends via Zoho Mail API.

Required config keys:
- `clientId`
- `clientSecret`
- `refreshToken`
- `accountId`

## Works with any AI framework

If your agent can write a JSON file, it can integrate.
- OpenClaw
- LangChain
- AutoGen
- custom scripts
- local automation tools

No runtime coupling to agent framework internals.

## Development notes

- TypeScript + NodeNext ESM
- Native `fetch` (no axios)
- File-based queue, no DB

## License

MIT — see [LICENSE](./LICENSE)
