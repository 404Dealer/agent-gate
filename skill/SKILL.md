---
name: agent-gate
description: Send emails and external actions through a human-approved deterministic gate. Use when the user asks Hermes to send, reply, forward, trigger a webhook, or perform any external side effect that should be reviewed before execution.
version: 1.0.0
author: 404Dealer
license: MIT
metadata:
  hermes:
    tags: [email, approval, hermes, security, prompt-injection, outbound-actions]
---

# agent-gate — Hermes Outbound Action Gate

agent-gate lets Hermes **propose** outbound actions while a separate process owns approval and execution. Hermes writes a JSON draft into a write-only inbox; agent-gate previews the exact draft in Telegram; the human approves or denies; a deterministic provider sends exactly what was approved.

**Hermes must not send directly when this skill is active.** Draft only, then tell the user it is pending approval.

## Security Contract

Use this skill only when the deployment preserves the structural boundary:

1. agent-gate runs as a separate OS user, normally `agentgate`.
2. Hermes can write only to the inbox directory, normally `/opt/agent-gate/drafts/inbox`.
3. Hermes cannot read/list/modify `pending/`, `approved/`, `sent/`, `denied/`, `failed/`, config, provider credentials, or the Telegram approval bot token.
4. agent-gate config has `security.enforceProductionPermissions: true` in production.
5. Send credentials live only in agent-gate, not in Hermes.

If any of these are false, the gate is a convenience workflow, not a hard security boundary.

## When to Use

Use for:

- sending or replying to email
- forwarding email
- sending webhooks/API calls
- social posts or other external side effects once providers exist
- any prompt-injection-sensitive workflow where Hermes can read untrusted text and then might act externally

Do **not** use for:

- read-only email search/summarization
- drafting text for the user to copy manually
- internal file edits that do not leave the machine

## Draft Workflow

1. Gather the user’s requested recipients, subject, body, provider, and context.
2. Write a valid draft JSON file into the inbox.
3. Tell the user what was drafted and that approval is pending in Telegram.
4. Do **not** claim the action was sent. It is only pending until agent-gate reports success to the human.

## Helper Script

Preferred path from Hermes:

```bash
/path/to/agent-gate/skill/scripts/draft-email.sh \
  'recipient@example.com' \
  'Subject line' \
  '<p>HTML body</p>' \
  'zoho' \
  'User asked me to follow up after our call' \
  'hermes-agent'
```

The helper uses `sg agentgate-inbox` to drop the file into `/opt/agent-gate/drafts/inbox`. If the production path differs, set `AGENT_GATE_INBOX` before running the helper.

## Manual Draft Schema

```json
{
  "id": "UUID-v4",
  "type": "email",
  "status": "pending",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "source": "hermes-agent",
  "provider": "zoho",
  "payload": {
    "from": "ignored@example.com",
    "to": "recipient@example.com",
    "subject": "Subject line",
    "body": "<p>HTML body</p>",
    "cc": [],
    "bcc": [],
    "replyTo": ""
  },
  "metadata": {
    "context": "Why Hermes drafted this; shown in approval preview",
    "priority": "normal",
    "tags": ["follow-up"]
  }
}
```

Rules:

- `id` must be UUID v4. Generate with `cat /proc/sys/kernel/random/uuid`.
- `status` must be `pending`.
- `from` is accepted for compatibility but ignored by agent-gate; the configured provider sender is shown in the approval preview and used for execution.
- `body` supports HTML and is limited to 256KB by schema.
- Long/truncated previews are deny-only by default unless the operator explicitly opts into `approval.allowTruncatedApproval`.
- `metadata.context` should explain why this draft exists; the human sees it.

## After Submitting

Reply to the user with:

- recipient(s)
- subject
- one-sentence summary
- “Waiting for approval in agent-gate Telegram.”

Never say “sent” unless the deterministic gate itself reports a sent status.

## Common Pitfalls

1. **Giving Hermes send credentials.** This defeats the hard boundary. Hermes can read/search/draft; agent-gate sends.
2. **Running Hermes and agent-gate as the same Unix user.** This lets Hermes tamper with pending drafts. Use the production deployment guide.
3. **Approving truncated content.** If the body is too long for Telegram preview, keep deny-only approval unless you have a full-draft review path.
4. **Trusting draft `from`.** It is ignored. The provider config is authoritative.
5. **Checking status from the inbox.** The inbox is write-only; the human sees status in Telegram and audit logs.

## Verification Checklist

- [ ] Draft JSON validates and is under 512KB
- [ ] Draft was written to the inbox, not to pending/approved directly
- [ ] User was told the draft is pending approval, not sent
- [ ] No send credential was used by Hermes
- [ ] For production, `security.enforceProductionPermissions` is enabled
