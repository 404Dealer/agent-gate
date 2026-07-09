# Hermes Integration Guide

agent-gate is designed to be the **send boundary** for Hermes Agent. Hermes can still be useful — reading mail, summarizing, drafting, researching — while agent-gate owns approval and final execution.

## Recommended Architecture

```text
Hermes Agent                         agent-gate
------------                         ----------
read/search/summarize email      ->  no access needed
draft outbound email JSON        ->  write-only inbox
NO SMTP/API send credentials         owns send credentials
NO approval bot token                owns Telegram approval bot
```

This makes prompt injection less dangerous: an email can influence what Hermes drafts, but it cannot make Hermes send because Hermes has no send credentials and no approval channel.

## Install the Skill

Copy or symlink this repo's `skill/` directory into Hermes:

```bash
mkdir -p ~/.hermes/skills/security
ln -s /opt/agent-gate/skill ~/.hermes/skills/security/agent-gate
```

Start a new Hermes session or `/reset` so the skill is discoverable.

## Give Hermes Write-Only Inbox Access

Production deployment creates:

```text
/opt/agent-gate/drafts/inbox
```

with mode `1730` and group `agentgate-inbox`. Add the Hermes OS user to that group:

```bash
sudo usermod -aG agentgate-inbox spacex   # replace spacex with the Hermes user
```

Log out/in or restart the Hermes gateway so the new group is active.

## Remove Direct Send Paths from Hermes

For a hard boundary, do not configure these in Hermes:

- SMTP send credentials
- Gmail send scopes
- Zoho/SendGrid/Mailgun API keys
- agent-gate Telegram bot token

Read-only mailbox access is fine. Drafting is fine. Sending belongs to agent-gate.

## Daily Use From Hermes

When the user says:

> Reply to Alice and tell her Friday works.

Hermes should:

1. read the relevant thread if mailbox read access exists;
2. draft the reply JSON using the `agent-gate` skill;
3. write the draft to the inbox;
4. respond: “Drafted and waiting for approval in agent-gate Telegram.”

Hermes should **not** say “sent” and should not call any direct send tool.

## Production Check

Set this in `/opt/agent-gate/config.yaml`:

```yaml
security:
  enforceProductionPermissions: true
```

agent-gate will fail closed at startup if the write-only inbox or private state directories are misconfigured.
