# Credential Handoff Without Exposing Send Secrets to Hermes

This guide describes the recommended operator flow when Hermes Agent installs and uses agent-gate, but must **not** receive Gmail, Zoho, Outlook, SMTP, or approval-bot send credentials.

## Goal

Hermes should be able to:

- install agent-gate scaffolding;
- configure non-secret settings;
- write outbound drafts to the write-only inbox;
- check service health and logs if allowed.

Hermes should **not** be able to:

- read provider send credentials;
- read the agent-gate approval bot token;
- approve its own drafts;
- read pending/approved/sent draft payloads;
- send email directly.

## Operator Responsibilities

The human operator is responsible for the few actions that intentionally cross the security boundary:

| Responsibility | Why Hermes should not own it |
|----------------|------------------------------|
| Create the separate agent-gate Telegram bot | The bot token controls approvals; Hermes must not be able to approve its own drafts |
| Authorize provider send scopes | Gmail/Zoho/Outlook send scopes are the actual send capability |
| Store provider secrets under the `agentgate` user | Keeps send credentials outside the Hermes OS user and logs |
| Verify the configured sender address | Approval previews are only meaningful if the real configured sender is correct |
| Approve or deny every outbound payload | Human approval is the control point |
| Keep recovery access outside Hermes | If Hermes breaks or is compromised, the operator still controls the gate |

## The Safe Split-Install Pattern

Use a two-phase setup:

### Phase A — Hermes-assisted install

Hermes may run or prepare commands that create the non-secret infrastructure:

```bash
sudo scripts/install-production.sh \
  --agent-user spacex \
  --telegram-user-id 2061243435
```

This creates users, groups, directories, permissions, a systemd service, and a config skeleton. It is okay for Hermes to assist with this because no send credentials need to be entered into Hermes.

### Phase B — Human-only credential handoff

Store the separate approval-bot token first, because the OAuth helper restarts the service after a successful config commit:

```bash
sudo /opt/agent-gate/scripts/configure-provider-secrets.sh telegram
```

Then authorize an email provider from a local terminal, SSH session, or console that is **not being driven by Hermes**:

```bash
sudo /opt/agent-gate/scripts/oauth-setup.sh gmail
# or
sudo /opt/agent-gate/scripts/oauth-setup.sh outlook
# or
sudo /opt/agent-gate/scripts/oauth-setup.sh zoho
```

The helper runs OAuth as `agentgate`, stores the resulting refresh token directly in that user's encrypted `pass` store, writes only versioned `${PASS:...}` references into the private config, and restarts the service. See [oauth-onboarding.md](oauth-onboarding.md).

For manual email recovery when OAuth onboarding cannot be used, the operator can run the installed fallback helper, for example:

```bash
sudo /opt/agent-gate/scripts/configure-provider-secrets.sh gmail
```

Do **not** paste these values into a Hermes chat, Telegram DM with Hermes, issue comment, PR comment, or terminal command that Hermes is executing.

## Recommended Credential Model

The preferred model is:

```text
Hermes installs infrastructure -> human/OAuth flow gives secrets directly to agentgate
```

Hermes may install packages, create users/groups, write non-secret config, and verify service health. Provider send credentials should enter through either:

1. the shipped PKCE browser flow in `scripts/oauth-setup.sh`, which terminates as `agentgate` and writes directly to its encrypted store (with Outlook device code available only as an explicit fallback); or
2. the human-run manual fallback `scripts/configure-provider-secrets.sh`.

Do **not** treat this as equivalent:

```text
Hermes receives secret -> Hermes stores it -> Hermes deletes it
```

Deletion is cleanup, not isolation. Once Hermes receives a secret, it may already exist in chat history, session logs, model context, terminal output, shell history, crash logs, or backups. If the goal is a hard send boundary, Hermes should never receive the send credential in the first place.

## Why Not Enter Secrets in the Approval Bot?

The approval bot should stay narrow:

```text
show exact outbound payload -> approve/deny
```

Using the same Telegram bot for credential entry is possible, but it expands the threat surface:

- Telegram messages may remain in chat history.
- Bot frameworks and logs can accidentally capture messages.
- A compromised Telegram session becomes a credential-admin session.
- The approval bot becomes both an approval UI and a secret-management control plane.
- The implementation must handle deletion, redaction, retries, partial input, and lockout rules.

For v1, prefer local/SSH credential handoff or OAuth device/browser flow that terminates inside the `agentgate` service account.

## Provider Token Patterns

### Gmail / Google

Supported provider type: `email-gmail`.

Required Gmail data scope plus basic sender identity scopes:

```text
openid
email
https://www.googleapis.com/auth/gmail.send
```

Recommended storage keys for the Desktop/public-client flow:

```text
agent-gate/google-client-id
agent-gate/google-refresh-token
```

No Google client secret is used by secure Desktop onboarding.

Hermes may have separate read-only Gmail access if desired, but it should not have the `gmail.send` refresh token if agent-gate is the send boundary.

### Zoho

Supported provider type: `email-zoho`.

Recommended storage keys:

```text
agent-gate/zoho-client-id
agent-gate/zoho-client-secret
agent-gate/zoho-refresh-token
```

The discovered Zoho `accountId`, selected region, and sender address are safe metadata in private config, not password-store secrets.

As with Gmail, Hermes should not receive the Zoho send refresh token or any app password/API token that can send mail directly.

### Outlook / Microsoft 365

Supported provider type: `email-outlook`.

Required delegated scopes for onboarding and send:

```text
offline_access
Mail.Send
User.Read  # used during onboarding to discover the authenticated mailbox
```

Recommended storage keys for the public-client PKCE flow (and device-code fallback):

```text
agent-gate/microsoft-client-id
agent-gate/microsoft-refresh-token
```

No Microsoft client secret is used. Secure onboarding sets `refreshTokenKey: agent-gate/microsoft-refresh-token` so replacement refresh tokens are persisted back to the encrypted store.

For Outlook, the same rule applies: the refresh token that can send mail belongs only to `agentgate`, not Hermes. The provider exchanges that refresh token for a short-lived Graph access token and calls `sendMail` only after human approval.

## How Hermes Can Install Nearly Everything Without Seeing Secrets

The safest workflow is:

1. Hermes clones the repo and runs tests/build.
2. Hermes runs the production installer with sudo approval.
3. Hermes writes non-secret config values and docs.
4. Hermes stops before any provider authorization.
5. The operator runs `scripts/oauth-setup.sh` from their own terminal/SSH session.
6. OAuth tokens travel directly from the provider to an `agentgate` process and its encrypted store.
7. The wrapper restarts `agent-gate` after successful persistence.
8. Hermes verifies only service health and writes a harmless test draft to the inbox.

Hermes can verify that secrets are **referenced**, without seeing their values:

```bash
sudo -u agentgate pass ls agent-gate
sudo systemctl status agent-gate --no-pager
```

Hermes should not run commands like:

```bash
GOOGLE_REFRESH_TOKEN=... hermes ...
echo "secret" | sudo -u agentgate pass insert ...
```

Those expose secrets to shell history, process inspection, logs, or the Hermes transcript.

## Final Boundary Check

After setup, these should be true:

```text
Hermes user can write to /opt/agent-gate/drafts/inbox
Hermes user cannot list/read /opt/agent-gate/drafts/inbox
Hermes user cannot read /opt/agent-gate/config/config.yaml
Hermes user cannot read /home/agentgate/.password-store
Hermes user cannot read the agent-gate Telegram bot token
Hermes has no Gmail/Zoho/Outlook send credentials
agent-gate starts with security.enforceProductionPermissions: true
```
