# Hermes Integration Guide

Nightdrop is designed to be the **send boundary** for Hermes Agent. Hermes can still be useful — reading mail, summarizing, drafting, researching — while Nightdrop owns approval and final execution.

## Recommended Architecture

```text
Hermes Agent                         Nightdrop
------------                         ----------
named Gmail/Outlook list/read/mark -> fixed Unix-socket broker
draft outbound email JSON         ->  write-only inbox
Trash/unsubscribe proposal        ->  Telegram approval snapshot
NO SMTP/IMAP/OAuth credentials        owns provider credentials
NO approval bot token                 owns Telegram approval bot
```

This makes prompt injection less dangerous: an email can influence what Hermes drafts, while final execution remains behind Nightdrop's separate credentials and approval channel. The hard-boundary claim additionally requires that Hermes cannot administer the Nightdrop host or service identity.

## Hermes Built-In Approval vs Nightdrop

Hermes has its own approval controls for risky tool use and shell commands. Those controls are valuable, but they answer a different question than Nightdrop.

| Question | Use Hermes built-in approval | Use Nightdrop |
|----------|------------------------------|----------------|
| “Should this command/tool run?” | ✅ | Not the main job |
| “Should this exact email/reply/webhook be sent?” | Behavioral only | ✅ |
| “Can the agent bypass the approval if it has send credentials?” | Yes, if those credentials/tools exist | No, if credentials live only in Nightdrop |
| “Is approval tied to a concrete payload hash?” | No general email-payload boundary | ✅ full hash + nonce |
| “Does a separate process execute the final send?” | Usually no | ✅ |

So the safe Hermes pattern is:

```text
Hermes approval: local/risky tool operation approval
Nightdrop: external outbound payload approval
```

They work together. Nightdrop is not replacing Hermes approval; it adds a structural send boundary for prompt-injection-sensitive outbound actions.

## Hard Requirements

For Hermes + Nightdrop to be a hard boundary:

- Hermes and Nightdrop must run as different OS users.
- Hermes should only have write-only inbox access through the `nightdrop-inbox` group.
- Hermes should receive mailbox access only through the fixed broker socket and `nightdrop-mailbox` capability group.
- Hermes must not have Gmail/Zoho/SMTP send credentials.
- Hermes must not have raw Gmail IMAP credentials or an arbitrary IMAP client path.
- Hermes must not have the Nightdrop Telegram bot token.
- Hermes must not have passwordless root, writable Docker/LXD/Incus/libvirt administration sockets, or an equivalent path to Nightdrop's credentials. Use strict mode or a separate trust domain when that guarantee is required.
- Nightdrop should run with `security.enforceProductionPermissions: true`.
- Production directory permissions should match `docs/deployment.md`.

If these are not true, Nightdrop still provides a useful review UX, but Hermes may be able to bypass it.

## Install the Skill

Copy or symlink this repo's `skill/` directory into Hermes:

```bash
mkdir -p ~/.hermes/skills
ln -sfn /opt/nightdrop/skill ~/.hermes/skills/nightdrop
hermes skills list
```

Restart the Hermes gateway or start a new session, then verify `nightdrop` appears as an enabled local skill.

## Hermes-Assisted Install Without Sharing Send Credentials

A secure install should be split into two parts:

1. **Hermes-assisted infrastructure setup** — Hermes can clone the repo, run tests/build, run `scripts/install-production.sh`, set non-secret config values, and verify systemd health.
2. **Human-only provider credential handoff** — the operator runs `scripts/smtp-setup.sh` or `scripts/oauth-setup.sh` from their own terminal/SSH session, outside the Hermes conversation. The App Password or OAuth token goes directly to a `nightdrop` process.

Example infrastructure command Hermes can help prepare or run after explicit sudo approval:

```bash
sudo scripts/install-production.sh \
  --agent-user spacex \
  --deployment-profile standard \
  --telegram-user-id 2061243435
```

If the installer detects host-administration capability, it stops before identity mutation. Re-run with `--acknowledge-agent-host-admin-risk` only when you intentionally accept that Hermes could technically bypass same-host Unix permissions. For a hard same-host boundary, use a dedicated account and `--deployment-profile strict`. A separate VM is an optional high-assurance topology, not the normal installation requirement.

Store the separate Telegram approval-bot token first; onboarding restarts the service:

```bash
sudo /opt/nightdrop/scripts/configure-provider-secrets.sh telegram
```

The simplest Gmail path is a dedicated, revocable Google App Password. Add `--profile` when an account should be available through the bounded Inbox broker:

```bash
sudo /opt/nightdrop/scripts/smtp-setup.sh gmail
sudo /opt/nightdrop/scripts/smtp-setup.sh gmail --profile personal
```

This avoids Google Cloud/OAuth app setup. It requires Google 2-Step Verification and App Password availability, and the credential is broader than a `gmail.send` OAuth token. See [smtp-onboarding.md](smtp-onboarding.md).

For narrower OAuth authorization instead:

```bash
sudo /opt/nightdrop/scripts/oauth-setup.sh gmail
# or
sudo /opt/nightdrop/scripts/oauth-setup.sh outlook
sudo /opt/nightdrop/scripts/oauth-setup.sh outlook --profile work
# or
sudo /opt/nightdrop/scripts/oauth-setup.sh zoho
```

Do not paste Gmail/Zoho/Outlook refresh tokens, SMTP/App Passwords, API keys, or the Nightdrop approval bot token into Hermes. Hermes can verify that secret references exist, but it should not print or receive their values.

Do not rely on “Hermes will delete the credentials afterward” as a security boundary. Once Hermes sees a secret, it may already be present in chat/session history, logs, shell history, model context, or backups. The secure pattern is: Hermes installs infrastructure, then a human-run helper gives secrets directly to `nightdrop`.

See [credential-handoff.md](credential-handoff.md) for detailed operator responsibilities, [smtp-onboarding.md](smtp-onboarding.md) for Gmail App Password setup, and [oauth-onboarding.md](oauth-onboarding.md) for provider registration, SSH tunnels, scopes, and browser/device flows.

## Give Hermes Write-Only Inbox Access

Production deployment creates:

```text
/opt/nightdrop/drafts/inbox
```

with mode `1730` and group `nightdrop-inbox`. Add the Hermes OS user to that group:

```bash
sudo usermod -aG nightdrop-inbox spacex   # replace spacex with the Hermes user
```

Log out/in or restart the Hermes gateway so the new group is active.

## Remove Direct Send Paths from Hermes

For a hard boundary, do not configure these in Hermes:

- SMTP send credentials
- Gmail send scopes
- Zoho/SendGrid/Mailgun API keys
- Nightdrop Telegram bot token

Bounded brokered mailbox access is fine. Direct mailbox credentials are not. Drafting is fine. Sending belongs to Nightdrop.

## Bounded Multi-Account Mailbox Workflow

The production client provides the only Gmail/Outlook mailbox capability Hermes should receive:

```bash
/usr/local/bin/nightdrop-mailbox profiles
/usr/local/bin/nightdrop-mailbox list --profile personal --unread --limit 20
/usr/local/bin/nightdrop-mailbox list --profile work --unread --limit 20
/usr/local/bin/nightdrop-mailbox read MESSAGE_REF
/usr/local/bin/nightdrop-mailbox mark-read MESSAGE_REF [MESSAGE_REF ...]
/usr/local/bin/nightdrop-mailbox propose-trash MESSAGE_REF [MESSAGE_REF ...] --context 'Why these messages are unwanted'
/usr/local/bin/nightdrop-mailbox propose-unsubscribe MESSAGE_REF --context 'Why this subscription should stop'
```

Each `profiles` result includes the exact outbound `provider` key for that account; use it for reply drafts without reading private config or deriving it from the profile name. Each profile fixes one provider account, the Inbox folder, operations, and bounds. Gmail uses opaque references tied to the current Inbox `UIDVALIDITY`; Outlook uses Graph immutable message IDs. Legacy Gmail references remain bound only to the unique `gmail-smtp` compatibility provider, whether it is exposed as `default` or explicitly named. Every reference also binds its profile/backend, mixed-profile bulk requests fail closed, and stale references fail closed. Reading does not mark mail read. Mark-read changes only exact references.

Trash and unsubscribe are proposals, not direct actions. Nightdrop fetches authoritative message metadata, binds the exact snapshot to a random single-use Telegram token, and executes only after approval. Gmail Trash uses native IMAP MOVE and never EXPUNGEs; Outlook Trash uses the fixed Graph move endpoint with destination `deleteditems`. Unsubscribe accepts only standardized headers: RFC 8058 HTTPS one-click first, then one strict RFC 2369 `mailto:` fallback. Message-body links, browser sessions, redirects, cookies, arbitrary URLs, and permanent deletion are unavailable.

If a Hermes process predates mailbox-group installation, use this temporary fallback until the process is restarted or the user logs in again:

```bash
sg nightdrop-mailbox -c '/usr/local/bin/nightdrop-mailbox list --profile PROFILE --unread --limit 20'
```

## Daily Use From Hermes

When the user says:

> Reply to Alice and tell her Friday works.

Hermes should:

1. read the relevant thread if mailbox read access exists;
2. draft the reply JSON using the `nightdrop` skill;
3. write the draft to the inbox;
4. respond: “Drafted and waiting for approval in Nightdrop Telegram.”

Hermes should **not** say “sent” and should not call any direct send tool.

For mailbox cleanup, Hermes may summarize bounded broker results and mark exact references read when the user has granted that permission. It may create Trash or unsubscribe proposals, but must report them as pending until the Telegram gate reports the result.

## Production Check

Set this in `/opt/nightdrop/config/config.yaml`:

```yaml
security:
  enforceProductionPermissions: true
```

Nightdrop fails closed at startup when queue path types, required modes, service ownership, or the root-owned draft parent are wrong. The installer separately validates the managed identity graph and behaviorally probes ordinary agent access. Neither check proves that every possible host-administration or privilege-escalation path is absent.
