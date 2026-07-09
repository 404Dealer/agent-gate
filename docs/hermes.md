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
mkdir -p ~/.hermes/skills
ln -sfn /opt/agent-gate/skill ~/.hermes/skills/agent-gate
hermes skills list
```

Restart the Hermes gateway or start a new session, then verify `agent-gate` appears as an enabled local skill.

## Hermes-Assisted Install Without Sharing Send Credentials

A secure install should be split into two parts:

1. **Hermes-assisted infrastructure setup** — Hermes can clone the repo, run tests/build, run `scripts/install-production.sh`, set non-secret config values, and verify systemd health.
2. **Human-only provider authorization** — the operator runs `scripts/oauth-setup.sh` from their own terminal or SSH session, outside the Hermes conversation. The browser/provider returns tokens directly to an `agentgate` process.

Example infrastructure command Hermes can help prepare or run after explicit sudo approval:

```bash
sudo scripts/install-production.sh \
  --agent-user spacex \
  --telegram-user-id 2061243435
```

Store the separate Telegram approval-bot token first; the OAuth helper restarts the service after onboarding:

```bash
sudo /opt/agent-gate/scripts/configure-provider-secrets.sh telegram
```

Then run one provider authorization command personally:

```bash
sudo /opt/agent-gate/scripts/oauth-setup.sh gmail
# or
sudo /opt/agent-gate/scripts/oauth-setup.sh outlook
# or
sudo /opt/agent-gate/scripts/oauth-setup.sh zoho
```

Do not paste Gmail/Zoho/Outlook refresh tokens, SMTP passwords, API keys, or the agent-gate approval bot token into Hermes. Hermes can verify that secret references exist, but it should not print or receive their values.

Do not rely on “Hermes will delete the credentials afterward” as a security boundary. Once Hermes sees a secret, it may already be present in chat/session history, logs, shell history, model context, or backups. The secure pattern is: Hermes installs infrastructure, then a human/OAuth flow gives secrets directly to `agentgate`.

See [credential-handoff.md](credential-handoff.md) for detailed operator responsibilities and [oauth-onboarding.md](oauth-onboarding.md) for provider registration, SSH tunnels, scopes, and browser/device flows.

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

Set this in `/opt/agent-gate/config/config.yaml`:

```yaml
security:
  enforceProductionPermissions: true
```

agent-gate will fail closed at startup if the write-only inbox or private state directories are misconfigured.
