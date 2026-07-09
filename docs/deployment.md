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

## Phase 2 — Directory Structure

```bash
sudo mkdir -p /opt/agent-gate/{src,dist,drafts/{inbox,pending,approved,sent,denied,failed}}

# Copy source and build
sudo cp -r /path/to/agent-gate/src/* /opt/agent-gate/src/
sudo cp /path/to/agent-gate/package.json /opt/agent-gate/
sudo cp /path/to/agent-gate/package-lock.json /opt/agent-gate/
sudo cp /path/to/agent-gate/tsconfig.json /opt/agent-gate/
sudo chown -R agentgate:agentgate /opt/agent-gate

sudo -u agentgate bash -c 'cd /opt/agent-gate && npm ci'
sudo -u agentgate bash -c 'cd /opt/agent-gate && npm run build'
```

### Set Permissions

```bash
# Main directory — traverse only (no listing)
sudo chmod 711 /opt/agent-gate
sudo chmod 711 /opt/agent-gate/drafts

# Source + build + deps — agentgate only
sudo chmod 700 /opt/agent-gate/src
sudo chmod 700 /opt/agent-gate/dist
sudo chmod -R go-rwx /opt/agent-gate/node_modules

# INBOX — true dropbox: write + traverse, no read, sticky bit
sudo chown agentgate:agentgate-inbox /opt/agent-gate/drafts/inbox
sudo chmod 1730 /opt/agent-gate/drafts/inbox

# Internal draft directories — agentgate only
for dir in pending approved sent denied failed; do
  sudo chown agentgate:agentgate /opt/agent-gate/drafts/$dir
  sudo chmod 700 /opt/agent-gate/drafts/$dir
done

# Audit log — agentgate writes, your user can read
sudo touch /opt/agent-gate/audit.log
sudo chown agentgate:agentgate /opt/agent-gate/audit.log
sudo chmod 640 /opt/agent-gate/audit.log
# Optional: grant read access to your user via ACL
sudo setfacl -m u:your-user:r /opt/agent-gate/audit.log
```

### Permission Summary

| Path | Owner | Mode | Agent's user can |
|------|-------|------|-----------------|
| `/opt/agent-gate/` | agentgate | 711 | Traverse only |
| `/opt/agent-gate/config.yaml` | agentgate | 600 | Nothing |
| `/opt/agent-gate/src/` | agentgate | 700 | Nothing |
| `/opt/agent-gate/dist/` | agentgate | 700 | Nothing |
| `/opt/agent-gate/drafts/` | agentgate | 711 | Traverse only |
| `/opt/agent-gate/drafts/inbox/` | agentgate:agentgate-inbox | 1730 | **Write only** (dropbox) |
| `/opt/agent-gate/drafts/pending/` | agentgate | 700 | Nothing |
| `/opt/agent-gate/drafts/approved/` | agentgate | 700 | Nothing |
| `/opt/agent-gate/drafts/sent/` | agentgate | 700 | Nothing |
| `/opt/agent-gate/audit.log` | agentgate | 640+ACL | Read only |

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

# Initialize pass store
AGENTGATE_GPG_FPR=$(sudo -u agentgate gpg --list-keys --with-colons | awk -F: '/^fpr:/ {print $10; exit}')
sudo -u agentgate bash -c "pass init $AGENTGATE_GPG_FPR"
```

Then run the human-only secret handoff helper from your own terminal:

```bash
# Do not run this through a Hermes conversation if Hermes must not see send creds.
sudo scripts/configure-provider-secrets.sh telegram
sudo scripts/configure-provider-secrets.sh gmail
# or
sudo scripts/configure-provider-secrets.sh zoho
```

The helper prompts for credentials and stores them under the `agentgate` user's `pass` store. Reference them in config with `${PASS:...}` syntax.

See [credential-handoff.md](credential-handoff.md) for the operator responsibilities, Gmail/Zoho token pattern, and the future Outlook/Microsoft Graph pattern.

## Phase 4 — Production Config

```bash
sudo -u agentgate tee /opt/agent-gate/config.yaml > /dev/null << 'EOF'
telegram:
  botToken: "${PASS:agent-gate/telegram-bot-token}"
  allowedUsers: [YOUR_TELEGRAM_USER_ID]

watch:
  directory: "/opt/agent-gate/drafts/inbox"
  pollIntervalMs: 2000

providers:
  gmail:
    type: "email-gmail"
    clientId: "${PASS:agent-gate/google-client-id}"
    clientSecret: "${PASS:agent-gate/google-client-secret}"
    refreshToken: "${PASS:agent-gate/google-refresh-token}"
    fromAddress: "you@gmail.com"
    displayName: "Your Name"

  zoho:
    type: "email-zoho"
    clientId: "${PASS:agent-gate/zoho-client-id}"
    clientSecret: "${PASS:agent-gate/zoho-client-secret}"
    refreshToken: "${PASS:agent-gate/zoho-refresh-token}"
    accountId: "${PASS:agent-gate/zoho-account-id}"
    fromAddress: "you@yourdomain.com"

  log:
    type: "log-only"

defaults:
  provider: "gmail"
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

sudo chmod 600 /opt/agent-gate/config.yaml
```

## Phase 5 — systemd Service

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
Environment=AGENT_GATE_CONFIG=/opt/agent-gate/config.yaml
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
