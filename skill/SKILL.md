---
name: agent-gate
description: Send emails and trigger external actions through a human-approved, deterministic approval pipeline. Use when the user asks to send an email, draft an email, send a message to someone, trigger a webhook, or perform any external action that requires human approval before execution. Also use when the user says "email," "send to," "draft to," "reach out to," or "message someone." The agent writes a JSON draft file; a separate Telegram bot presents it to the human for approval; a deterministic script executes exactly what was approved. No AI in the execution path.
---

# agent-gate — Deterministic Approval Layer

You have access to agent-gate, a tool that lets you draft external actions (emails, webhooks) that require human approval before execution. You write a JSON draft file to an inbox directory; a separate system handles preview, approval, and sending.

**You can only propose actions. You cannot send directly.** This is by design.

## How It Works

1. You write a JSON draft file to the inbox directory
2. agent-gate picks it up and sends a preview to the human's Telegram
3. The human taps Approve or Deny
4. If approved, a deterministic script sends exactly what was previewed

## Writing a Draft

Drop a `.json` file into the inbox. Use `sg agentgate-inbox` to write to the dropbox directory:

```bash
sg agentgate-inbox -c 'cat > /opt/agent-gate/drafts/inbox/FILENAME.json << '\''DRAFT'\''
{JSON_CONTENT}
DRAFT'
```

### Draft Schema

Every draft must include these fields:

```json
{
  "id": "UUID-v4",
  "type": "email",
  "status": "pending",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "source": "agent-name",
  "provider": "zoho",
  "payload": {
    "from": "ignored@example.com",
    "to": "recipient@example.com",
    "subject": "Subject line (max 500 chars)",
    "body": "HTML content (max 256KB)",
    "cc": [],
    "bcc": [],
    "replyTo": ""
  },
  "metadata": {
    "context": "Why you drafted this (shown to human in preview)",
    "priority": "normal",
    "tags": ["tag1", "tag2"]
  }
}
```

**Important:**
- `id` must be a valid UUID v4. Generate one with: `$(cat /proc/sys/kernel/random/uuid)`
- `status` must be `"pending"` for new drafts
- `from` is ignored — the configured sender address is always used
- `provider` must match a configured provider key (check config)
- `body` supports HTML
- `context` in metadata is shown to the human — explain WHY you're sending this

### Filename Convention

Use descriptive filenames: `{purpose}-{timestamp}.json`

Examples: `follow-up-2026-02-21.json`, `job-app-acme-corp.json`, `weekly-update.json`

### Complete Example

```bash
DRAFT_ID=$(cat /proc/sys/kernel/random/uuid)
DRAFT_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

sg agentgate-inbox -c "cat > /opt/agent-gate/drafts/inbox/follow-up-$(date +%Y%m%d).json << 'DRAFT'
{
  \"id\": \"$DRAFT_ID\",
  \"type\": \"email\",
  \"status\": \"pending\",
  \"createdAt\": \"$DRAFT_TS\",
  \"updatedAt\": \"$DRAFT_TS\",
  \"source\": \"main-agent\",
  \"provider\": \"zoho\",
  \"payload\": {
    \"from\": \"noreply@example.com\",
    \"to\": \"recipient@example.com\",
    \"subject\": \"Following up on our conversation\",
    \"body\": \"<p>Hi,</p><p>Just following up on our chat yesterday. Let me know if you have any questions.</p><p>Best,<br>Johnny</p>\",
    \"cc\": [],
    \"bcc\": [],
    \"replyTo\": \"\"
  },
  \"metadata\": {
    \"context\": \"User asked me to follow up after yesterday's meeting\",
    \"priority\": \"normal\",
    \"tags\": [\"follow-up\"]
  }
}
DRAFT"
```

## After Drafting

After writing the draft file, tell the user:
- What you drafted (to, subject, brief summary)
- That it's waiting for their approval in Telegram
- They can approve or deny it there

Do NOT tell the user the email has been sent. It hasn't — it's pending approval.

## Checking Draft Status

The inbox is write-only — you cannot read back drafts or check status. The human sees the status in Telegram. If asked about a draft's status, tell the user to check their Telegram bot (@CounterSign_bot).

## Providers

Available providers depend on the agent-gate config. Common ones:
- `zoho` — sends email via Zoho Mail API
- `log` — dry run, logs but doesn't send (for testing)

## Constraints

- Max subject: 500 characters
- Max body: 256KB
- Max tags: 20
- Max context: 1000 characters
- Only regular files accepted (no symlinks)
- Max file size: 512KB
- Draft must be valid JSON and pass schema validation or it goes to `failed/`
