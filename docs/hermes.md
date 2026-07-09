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

## Hermes Built-In Approval vs agent-gate

Hermes has its own approval controls for risky tool use and shell commands. Those controls are valuable, but they answer a different question than agent-gate.

| Question | Use Hermes built-in approval | Use agent-gate |
|----------|------------------------------|----------------|
| “Should this command/tool run?” | ✅ | Not the main job |
| “Should this exact email/reply/webhook be sent?” | Behavioral only | ✅ |
| “Can the agent bypass the approval if it has send credentials?” | Yes, if those credentials/tools exist | No, if credentials live only in agent-gate |
| “Is approval tied to a concrete payload hash?” | No general email-payload boundary | ✅ full hash + nonce |
| “Does a separate process execute the final send?” | Usually no | ✅ |

So the safe Hermes pattern is:

```text
Hermes approval: local/risky tool operation approval
agent-gate: external outbound payload approval
```

They work together. agent-gate is not replacing Hermes approval; it adds a structural send boundary for prompt-injection-sensitive outbound actions.

## Hard Requirements

For Hermes + agent-gate to be a hard boundary:

- Hermes and agent-gate must run as different OS users.
- Hermes should only have write-only inbox access through the `agentgate-inbox` group.
- Hermes must not have Gmail/Zoho/SMTP send credentials.
- Hermes must not have the agent-gate Telegram bot token.
- agent-gate should run with `security.enforceProductionPermissions: true`.
- Production directory permissions should match `docs/deployment.md`.

If these are not true, agent-gate still provides a useful review UX, but Hermes may be able to bypass it.

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
