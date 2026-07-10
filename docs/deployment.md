# Production Deployment Guide

This guide walks through deploying agent-gate with full process isolation. By the end, your AI agent will only be able to drop drafts into a write-only inbox — it cannot read, modify, or delete anything after submission.

## Overview

Production deployment has one goal: the agent can submit drafts, but cannot approve, alter, inspect, or send them.

### Minimum Production Requirements

- Separate Unix service user for agent-gate, for example `agentgate`.
- Dedicated inbox group, for example `agentgate-inbox`.
- Inbox mode `1730`, owned by `agentgate:agentgate-inbox`.
- Internal state directories (`pending`, `approved`, `sent`, `denied`, `failed`) mode `0700`, owned by `agentgate:agentgate`.
- Provider send credentials readable only by `agentgate`.
- Telegram approval bot token readable only by `agentgate`.
- Agent/Hermes user added only to `agentgate-inbox`, **not** to the `agentgate` group.
- `security.enforceProductionPermissions: true` in config.

If any of these are skipped, agent-gate may still work, but it is no longer enforcing the full structural boundary.

| Component | Runs As | Can Do | Must Not Be Able To Do |
|-----------|---------|--------|-------------------------|
| AI Agent / Hermes | `your-user` | Write files to inbox only | Read/list inbox, read pending/approved/sent, access send credentials, access approval bot token |
| agent-gate | `agentgate` | Read inbox, send previews, execute approved drafts | Run arbitrary agent code |
| Telegram Bot | part of `agentgate` service | Receive approve/deny from authorized humans | Expose token to the agent |

## Phase 1 — Create Service User

```bash
# Non-login service user with locked home
sudo useradd -r -m -d /home/agentgate -s /usr/sbin/nologin agentgate
sudo chmod 700 /home/agentgate

# Dedicated group for the draft dropbox
sudo groupadd --system agentgate-inbox
sudo usermod -aG agentgate-inbox agentgate
sudo usermod -aG agentgate-inbox your-user  # Replace with your agent's user
# Re-login or run `newgrp agentgate-inbox` for the group to take effect
```

> ⚠️ Do **not** add your agent's user to the `agentgate` group — that would leak read access to agent-gate's files.

## Phase 2 — Install and Verify the Filesystem Boundary

Run the reviewed installer from the repository checkout:

```bash
sudo scripts/install-production.sh \
  --agent-user your-user \
  --telegram-user-id YOUR_TELEGRAM_USER_ID
```

The installer stops an already-active service during upgrades, installs lockfile dependencies with root lifecycle scripts disabled, compiles in a staged tree as a one-use unprivileged build account, and swaps in the verified output. It retains the previous runtime, config, and systemd unit until the upgraded service passes an active-state health check; any later failure restores those snapshots. The persistent `agentgate` service account never owns source or privileged helpers.

The only application-tree paths writable by `agentgate` are the dedicated config directory, draft state, and audit log. OAuth setup needs the config directory—not the application root—to be writable so it can atomically replace `config.yaml`.

### Permission Summary

| Path | Owner | Mode | Purpose / agent access |
|------|-------|------|------------------------|
| `/opt/agent-gate/` | `root:root` | `711` | Traverse only; prevents replacement of root-owned helpers |
| `/opt/agent-gate/scripts/` | `root:root` | `755` | Root-invoked helpers, immutable to `agentgate` and Hermes |
| `/opt/agent-gate/src/` | `root:root` | `700` | Build source, no service/Hermes access |
| `/opt/agent-gate/dist/` | `root:agentgate` | `750` dirs / `640` files | Service-readable runtime, not service-writable |
| `/opt/agent-gate/node_modules/` | `root:agentgate` | group read/execute | Service-readable dependencies, not service-writable |
| `/opt/agent-gate/config/` | `agentgate:agentgate` | `700` | Private atomic config updates |
| `/opt/agent-gate/config/config.yaml` | `agentgate:agentgate` | `600` | Private configuration; Hermes has no access |
| `/opt/agent-gate/drafts/` | `root:root` | `711` | Traverse only |
| `/opt/agent-gate/drafts/inbox/` | `agentgate:agentgate-inbox` | `1730` | Hermes **write only** dropbox |
| `/opt/agent-gate/drafts/{pending,approved,sent,denied,failed}/` | `agentgate:agentgate` | `700` | Private state |
| `/opt/agent-gate/audit.log` | `agentgate:agentgate` | `640` + optional ACL | Hermes/operator read only when explicitly granted |

Verify the critical parent and helper ownership after installation:

```bash
sudo stat -c '%U:%G %a %n' \
  /opt/agent-gate \
  /opt/agent-gate/scripts \
  /opt/agent-gate/scripts/oauth-setup.sh \
  /opt/agent-gate/scripts/smtp-setup.sh \
  /opt/agent-gate/config \
  /opt/agent-gate/config/config.yaml
```

## Phase 3 — Credentials

Use a dedicated `pass` store for the agentgate user. This keeps secrets out of environment variables and `/proc/environ`.

Hermes can help prepare the `agentgate` user and password store, but the human operator should enter provider send credentials from a terminal/SSH session that Hermes is not controlling.

```bash
# Generate GPG key for agentgate
sudo -u agentgate bash -c '
  gpg --batch --gen-key <<EOF
Key-Type: RSA
Key-Length: 4096
Subkey-Type: RSA
Subkey-Length: 4096
Name-Real: agent-gate
Name-Email: agentgate@localhost
Expire-Date: 0
%no-protection
%commit
EOF
'

# Initialize the empty pass store without invoking pass init.
# The fingerprint is public metadata; no secret is printed.
AGENTGATE_GPG_FPR=$(sudo -u agentgate env \
  HOME=/home/agentgate \
  GNUPGHOME=/home/agentgate/.gnupg \
  gpg --list-keys --with-colons | awk -F: '/^fpr:/ {print $10; exit}')
test -n "$AGENTGATE_GPG_FPR"
sudo install -d -m 0700 -o agentgate -g agentgate /home/agentgate/.password-store
printf '%s\n' "$AGENTGATE_GPG_FPR" | sudo tee /home/agentgate/.password-store/.gpg-id >/dev/null
sudo chown agentgate:agentgate /home/agentgate/.password-store/.gpg-id
sudo chmod 0600 /home/agentgate/.password-store/.gpg-id
```

Store the separate approval-bot token first. The OAuth wrapper restarts the service after successful onboarding, so this bootstrap credential must already exist:

```bash
sudo /opt/agent-gate/scripts/configure-provider-secrets.sh telegram
```

Then configure one email provider from your own terminal. Gmail App Password SMTP is the simplest self-hosted path:

```bash
# Do not run these through a Hermes conversation if Hermes must not see send credentials.
sudo /opt/agent-gate/scripts/smtp-setup.sh gmail
# Or use narrower/more involved OAuth authorization:
sudo /opt/agent-gate/scripts/oauth-setup.sh gmail
# or
sudo /opt/agent-gate/scripts/oauth-setup.sh outlook
# or
sudo /opt/agent-gate/scripts/oauth-setup.sh zoho
```

The SMTP helper verifies Gmail authentication over certificate-verified TLS, stores one versioned App Password directly in the `agentgate` `pass` store, atomically writes only its `${PASS:...}` reference plus safe sender metadata, and restarts the service. This path requires Google 2-Step Verification and App Password availability; it is simpler but the credential is broader than `gmail.send` OAuth. See [smtp-onboarding.md](smtp-onboarding.md).

The OAuth helper runs as `agentgate` with a clean environment, stores refresh credentials directly in its `pass` store, verifies the authenticated sender/account, atomically writes only versioned `${PASS:...}` references to private config, and restarts the service. Gmail, Outlook, and Zoho use a loopback SSH tunnel by default; Outlook offers an explicit higher-risk `--device-code` fallback. See [oauth-onboarding.md](oauth-onboarding.md).

See [credential-handoff.md](credential-handoff.md) for operator responsibilities and the hard boundary.

## Phase 4 — Production Config (Manual Install Reference Only)

> **If you used `scripts/install-production.sh`, skip this phase.** The installer created the private config and the SMTP/OAuth onboarding helper updated it. Never replace `config.yaml` with this example after onboarding; doing so would discard the verified sender metadata and versioned pass references.

```bash
sudo -u agentgate tee /opt/agent-gate/config/config.yaml > /dev/null << 'EOF'
telegram:
  botToken: "${PASS:agent-gate/telegram-bot-token}"
  allowedUsers: [YOUR_TELEGRAM_USER_ID]

watch:
  directory: "/opt/agent-gate/drafts/inbox"
  pollIntervalMs: 2000

providers:
  gmail-smtp:
    type: "email-smtp"
    host: "smtp.gmail.com"
    port: 465
    tlsMode: "implicit"
    username: "you@gmail.com"
    password: "${PASS:agent-gate/smtp-password-VERSION}"
    fromAddress: "you@gmail.com"
    displayName: "Your Name"

  gmail:
    type: "email-gmail"
    clientId: "${PASS:agent-gate/google-client-id}"
    # No clientSecret for Desktop/public-client onboarding.
    refreshToken: "${PASS:agent-gate/google-refresh-token}"
    fromAddress: "you@gmail.com"
    displayName: "Your Name"

  outlook:
    type: "email-outlook"
    clientId: "${PASS:agent-gate/microsoft-client-id}"
    # No clientSecret for recommended public-client PKCE/device flows.
    refreshToken: "${PASS:agent-gate/microsoft-refresh-token}"
    refreshTokenKey: "agent-gate/microsoft-refresh-token"
    tenantId: "common"
    fromAddress: "you@outlook.com"
    displayName: "Your Name"

  zoho:
    type: "email-zoho"
    clientId: "${PASS:agent-gate/zoho-client-id}"
    clientSecret: "${PASS:agent-gate/zoho-client-secret}"
    refreshToken: "${PASS:agent-gate/zoho-refresh-token}"
    region: "us"
    accountId: "YOUR_DISCOVERED_ACCOUNT_ID"
    fromAddress: "you@yourdomain.com"

  log:
    type: "log-only"

defaults:
  provider: "log"
  timezone: "America/Chicago"
  autoDeleteAfterDays: 30

approval:
  bodyPreviewChars: 2000
  allowTruncatedApproval: false

security:
  enforceProductionPermissions: true

audit:
  enabled: true
  logFile: "/opt/agent-gate/audit.log"
EOF

sudo chmod 600 /opt/agent-gate/config/config.yaml
```

## Phase 5 — systemd Service (Manual Install Reference Only)

> **If you used the production installer, do not replace its hardened unit.** The installer already wrote the unit and the SMTP/OAuth wrapper started or restarted it after onboarding. Use the commands below only for a fully manual installation.

```bash
sudo tee /etc/systemd/system/agent-gate.service > /dev/null << 'EOF'
[Unit]
Description=agent-gate — Deterministic Approval Layer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agentgate
Group=agentgate
WorkingDirectory=/opt/agent-gate
ExecStart=/usr/bin/node /opt/agent-gate/dist/index.js
Environment=AGENT_GATE_CONFIG=/opt/agent-gate/config/config.yaml
Environment=PASSWORD_STORE_DIR=/home/agentgate/.password-store
Environment=GNUPGHOME=/home/agentgate/.gnupg

# Restart policy
Restart=on-failure
RestartSec=10
StartLimitIntervalSec=300
StartLimitBurst=5

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=false
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
PrivateDevices=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UMask=0077
SystemCallArchitectures=native
ReadWritePaths=/opt/agent-gate/drafts /opt/agent-gate/audit.log /home/agentgate/.gnupg /home/agentgate/.password-store

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agent-gate

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable agent-gate
sudo systemctl start agent-gate
```

Verify it's running:

```bash
sudo systemctl status agent-gate --no-pager
sudo journalctl -u agent-gate -f
```

With `security.enforceProductionPermissions: true`, startup fails closed if the draft directories do not match the production isolation model. A healthy startup logs:

```text
✅ Draft directory isolation checks passed.
```

## Phase 6 — Restrict Your Agent's sudo (Optional)

If your agent's user currently has broad sudo access, lock it down to only what it needs:

```bash
sudo visudo -f /etc/sudoers.d/your-user
```

```sudoers
# Only allow checking agent-gate status and viewing logs
Defaults:your-user env_reset,use_pty
Cmnd_Alias SAFE_OPS = /usr/bin/systemctl status agent-gate.service, \
                       /usr/bin/journalctl -u agent-gate.service, \
                       /usr/bin/journalctl -u agent-gate.service -n *, \
                       /usr/bin/journalctl -u agent-gate.service -f

your-user ALL=(root) NOPASSWD: SAFE_OPS
```

Then remove any existing file granting `ALL=(ALL) ALL`.

## Dropping Drafts From Your Agent

Your agent writes to the inbox using the shared group:

```bash
# If your system has `sg` (switch group):
sg agentgate-inbox -c 'cat > /opt/agent-gate/drafts/inbox/my-draft.json << EOF
{
  "id": "...",
  "type": "email",
  ...
}
EOF'
```

The file lands in the dropbox. agent-gate picks it up, moves it to `pending/`, and sends you a Telegram preview. Your agent never sees it again.

## Verifying Isolation

Run these as your agent's user (no sudo):

```bash
# Should fail — can't list agent-gate directory
ls /opt/agent-gate/
# Expected: Permission denied

# Should fail — can't read inbox
ls /opt/agent-gate/drafts/inbox/
# Expected: Permission denied

# Should succeed — can write to inbox
echo '{}' > /opt/agent-gate/drafts/inbox/test.json
# Expected: Success (agent-gate will reject it as malformed and move to failed/)

# Should fail — can't read pending, approved, sent, etc.
ls /opt/agent-gate/drafts/pending/
# Expected: Permission denied

# Should succeed — can read audit log (if ACL set)
cat /opt/agent-gate/audit.log
# Expected: JSON audit entries
```
