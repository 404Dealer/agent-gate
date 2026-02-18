# ISOLATION-PLAN.md — Structural Isolation Runbook (v2)

> **Goal:** Make it structurally impossible for the AI agent (running as `devops`) to send emails directly. The only path to send is: write draft JSON → agent-gate (separate user) → human approves in Telegram → deterministic script sends exactly what was previewed.
>
> v2 incorporates findings from Codex security review (ISOLATION-REVIEW.md).

---

## Phase 1 — Create `agentgate` Linux User

### 1.1 Create user with locked home directory

```bash
sudo useradd -r -m -d /home/agentgate -s /bin/bash agentgate
sudo chmod 700 /home/agentgate
```

### 1.2 Create inbox group (NOT adding devops to agentgate group)

```bash
# Dedicated group for draft dropbox only
sudo groupadd agentgate-inbox
sudo usermod -aG agentgate-inbox devops
sudo usermod -aG agentgate-inbox agentgate
# devops needs to re-login or `newgrp agentgate-inbox` for group to take effect
```

> ⚠️ Do NOT add devops to the `agentgate` group — that would leak read access.

### 1.3 Generate GPG key for agentgate's pass store

```bash
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
```

### 1.4 Initialize pass store for agentgate

```bash
AGENTGATE_GPG_ID=$(sudo -u agentgate gpg --list-keys --keyid-format long | grep -A1 'pub' | tail -1 | awk '{print $1}')
sudo -u agentgate bash -c "pass init $AGENTGATE_GPG_ID"
```

### 1.5 Verify isolation

```bash
# As devops (no sudo):
ls /home/agentgate/
# Expected: Permission denied
```

---

## Phase 2 — Directory Layout at /opt/agent-gate

### 2.1 Create directory structure

```bash
sudo mkdir -p /opt/agent-gate/{src,dist,drafts/{inbox,pending,approved,sent,denied,failed}}
```

> Key change from v1: `drafts/inbox/` is the public dropbox. `drafts/pending/` is internal.

### 2.2 Copy source and build

```bash
sudo cp -r /home/devops/.openclaw/workspace/agent-gate/src/* /opt/agent-gate/src/
sudo cp /home/devops/.openclaw/workspace/agent-gate/package.json /opt/agent-gate/
sudo cp /home/devops/.openclaw/workspace/agent-gate/package-lock.json /opt/agent-gate/
sudo cp /home/devops/.openclaw/workspace/agent-gate/tsconfig.json /opt/agent-gate/
sudo cp /home/devops/.openclaw/workspace/agent-gate/config.example.yaml /opt/agent-gate/
sudo chown -R agentgate:agentgate /opt/agent-gate

sudo -u agentgate bash -c 'cd /opt/agent-gate && npm ci'
sudo -u agentgate bash -c 'cd /opt/agent-gate && npm run build'
```

### 2.3 Set permissions

```bash
# Main directory — agentgate only
sudo chown -R agentgate:agentgate /opt/agent-gate
sudo chmod 750 /opt/agent-gate

# Source, config, node_modules — agentgate only
sudo chmod 700 /opt/agent-gate/src
sudo chmod 700 /opt/agent-gate/dist
sudo chmod -R 700 /opt/agent-gate/node_modules
sudo chmod 600 /opt/agent-gate/config.yaml

# INBOX — true dropbox: agentgate owns, inbox group can write+execute, sticky bit
sudo chown agentgate:agentgate-inbox /opt/agent-gate/drafts/inbox
sudo chmod 1730 /opt/agent-gate/drafts/inbox
# Mode 1730: owner rwx, group wx (write+traverse, NO read), sticky prevents deletions by others

# All internal draft dirs — agentgate only
for dir in pending approved sent denied failed; do
  sudo chown agentgate:agentgate /opt/agent-gate/drafts/$dir
  sudo chmod 700 /opt/agent-gate/drafts/$dir
done

# Audit log — agentgate writes, devops can read
sudo touch /opt/agent-gate/audit.log
sudo chown agentgate:agentgate /opt/agent-gate/audit.log
sudo chmod 640 /opt/agent-gate/audit.log
sudo setfacl -m u:devops:r /opt/agent-gate/audit.log
```

### 2.4 Permission summary

| Path | Owner | Mode | devops can |
|------|-------|------|-----------|
| `/opt/agent-gate/` | agentgate:agentgate | 750 | ❌ nothing |
| `/opt/agent-gate/config.yaml` | agentgate:agentgate | 600 | ❌ nothing |
| `/opt/agent-gate/src/` | agentgate:agentgate | 700 | ❌ nothing |
| `/opt/agent-gate/dist/` | agentgate:agentgate | 700 | ❌ nothing |
| `/opt/agent-gate/drafts/inbox/` | agentgate:agentgate-inbox | 1730 | ✅ write-only (dropbox) |
| `/opt/agent-gate/drafts/pending/` | agentgate:agentgate | 700 | ❌ nothing |
| `/opt/agent-gate/drafts/approved/` | agentgate:agentgate | 700 | ❌ nothing |
| `/opt/agent-gate/drafts/sent/` | agentgate:agentgate | 700 | ❌ nothing |
| `/opt/agent-gate/drafts/denied/` | agentgate:agentgate | 700 | ❌ nothing |
| `/opt/agent-gate/audit.log` | agentgate:agentgate | 640+ACL | ✅ read only |

---

## Phase 3 — Code Changes (Before Service Deployment)

These changes must be applied to the source before deploying to /opt.

### 3.1 Inbox → Pending handoff with symlink protection + size limit

In `watcher.ts`: watch `inbox/` instead of `pending/`. On new file, reject symlinks, enforce max size, atomically `rename()` into private `pending/` before processing.

### 3.2 Hash-verified approvals (draft immutability)

In `bot.ts`: compute SHA-256 of draft content at preview time, embed in callback data. On approve, re-read file, recompute hash, reject if mismatched. Prevents draft-swap attacks.

### 3.3 Escape Telegram preview content

In `bot.ts`: escape all user-controlled fields before rendering, or use plain text mode instead of Markdown. Prevents preview spoofing.

### 3.4 Sanitize error messages

In `executor.ts` and `email-zoho.ts`: don't send raw API error bodies to Telegram or audit log. Log sanitized status code + safe message only.

### 3.5 Schema bounds

In `schema.ts`: add `max()` constraints on subject (500 chars), body (256KB), context (1000 chars), tags (20 max). Prevents resource abuse.

### 3.6 Config fails hard on unresolved placeholders

In `config.ts`: throw instead of substituting empty string when `${VAR}` can't be resolved.

### 3.7 From-address enforcement

In `email-zoho.ts`: ignore the `from` field in drafts, always use the configured sender. Prevents spoofing.

---

## Phase 4 — systemd Service

### 4.1 Create production config

```bash
sudo -u agentgate tee /opt/agent-gate/config.yaml > /dev/null << 'EOF'
telegram:
  botToken: "${PASS:agent-gate/telegram-bot-token}"
  allowedUsers: [2061243435]

watch:
  directory: "/opt/agent-gate/drafts/inbox"
  pollIntervalMs: 2000

providers:
  zoho:
    type: "email-zoho"
    clientId: "${PASS:agent-gate/zoho-client-id}"
    clientSecret: "${PASS:agent-gate/zoho-client-secret}"
    refreshToken: "${PASS:agent-gate/zoho-refresh-token}"
    accountId: "${PASS:agent-gate/zoho-account-id}"

  log:
    type: "log-only"

defaults:
  provider: "zoho"
  autoDeleteAfterDays: 30

audit:
  enabled: true
  logFile: "/opt/agent-gate/audit.log"
EOF
sudo chmod 600 /opt/agent-gate/config.yaml
```

> Uses `${PASS:key}` syntax — config.ts reads directly from agentgate's pass store at startup. No environment variables, no `/proc/environ` leak.

### 4.2 Create systemd unit file

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

# Restart policy
Restart=on-failure
RestartSec=10
StartLimitIntervalSec=300
StartLimitBurst=5

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
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
ReadWritePaths=/opt/agent-gate/drafts /opt/agent-gate/audit.log

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agent-gate

[Install]
WantedBy=multi-user.target
EOF
```

### 4.3 Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable agent-gate
sudo systemctl start agent-gate
sudo journalctl -u agent-gate -f
```

---

## Phase 5 — Credential Migration

### 5.1 Read current creds from devops pass

```bash
BOT_TOKEN="$(pass agent-gate/telegram-bot-token)"
ZOHO_CID="$(pass email/zoho/oauth-client-id)"
ZOHO_CSECRET="$(pass email/zoho/oauth-client-secret)"
ZOHO_RTOKEN="$(pass email/zoho/oauth-refresh-token)"
ZOHO_AID="$(pass email/zoho/account-id)"
```

### 5.2 Insert into agentgate's pass store

```bash
echo "$BOT_TOKEN" | sudo -u agentgate pass insert -e agent-gate/telegram-bot-token
echo "$ZOHO_CID" | sudo -u agentgate pass insert -e agent-gate/zoho-client-id
echo "$ZOHO_CSECRET" | sudo -u agentgate pass insert -e agent-gate/zoho-client-secret
echo "$ZOHO_RTOKEN" | sudo -u agentgate pass insert -e agent-gate/zoho-refresh-token
echo "$ZOHO_AID" | sudo -u agentgate pass insert -e agent-gate/zoho-account-id
```

### 5.3 Test the service works with agentgate's creds

```bash
sudo systemctl restart agent-gate
# Drop test draft into inbox, verify it appears in Telegram
```

### 5.4 Delete credentials from devops pass

⚠️ **Only after confirming the service works**

```bash
pass rm email/zoho/oauth-client-id
pass rm email/zoho/oauth-client-secret
pass rm email/zoho/oauth-refresh-token
pass rm email/zoho/account-id
pass rm agent-gate/telegram-bot-token
# KEEP email/zoho/engineer@johnnyr.dev — reader agent needs it (but verify it can't send, see 5.5)
```

### 5.5 Verify residual IMAP credential can't send

```bash
# Test if the IMAP app password allows SMTP send:
sudo apt install -y swaks 2>/dev/null
swaks --server smtp.zoho.com:587 --tls --auth LOGIN \
  --auth-user 'engineer@johnnyr.dev' \
  --auth-password "$(pass email/zoho/engineer@johnnyr.dev)" \
  --from engineer@johnnyr.dev --to test@example.com --quit-after AUTH
# If AUTH succeeds → this is a bypass. Need to rotate to a read-only app password.
# If AUTH fails → safe.
```

---

## Phase 6 — Sudo Restriction

### Option A: Allowlist-only (recommended starting point)

```bash
# Remove broad sudo access
sudo visudo -f /etc/sudoers.d/devops
```

Contents:
```sudoers
Defaults:devops env_reset,use_pty
Cmnd_Alias SAFE_OPS = /usr/bin/systemctl status *, /usr/bin/systemctl restart agent-gate.service, /usr/bin/journalctl -u agent-gate *

devops ALL=(root) NOPASSWD: SAFE_OPS
```

Then remove devops from any file granting `ALL=(ALL) ALL`.

### Option B: Separate admin user (strongest, do later)

```bash
sudo adduser admin
sudo usermod -aG sudo admin
# Johnny SSHs as admin for system tasks
# devops loses sudo entirely
```

---

## Execution Checklist

### Phase 1 — User
- [ ] Create `agentgate` user
- [ ] Create `agentgate-inbox` group, add devops + agentgate
- [ ] Generate GPG key for agentgate
- [ ] Initialize agentgate's pass store
- [ ] Verify devops can't read agentgate home

### Phase 2 — Directories
- [ ] Create /opt/agent-gate structure
- [ ] Copy source, install deps, build
- [ ] Set all permissions per table
- [ ] Verify devops can write to inbox/ but not read anything else

### Phase 3 — Code Changes
- [ ] Inbox → pending handoff + symlink rejection + size limit
- [ ] Hash-verified approvals
- [ ] Escape Telegram preview / use plain text
- [ ] Sanitize error messages
- [ ] Schema bounds
- [ ] Config fail-hard on unresolved vars
- [ ] From-address enforcement

### Phase 4 — Service
- [ ] Create production config.yaml with PASS: syntax
- [ ] Create systemd unit file with full hardening
- [ ] Enable and start service
- [ ] Verify bot responds

### Phase 5 — Credentials
- [ ] Migrate all creds to agentgate pass
- [ ] Test service works with new creds
- [ ] Delete creds from devops pass
- [ ] Verify IMAP password can't send
- [ ] Verify devops can't call Zoho API

### Phase 6 — Sudo
- [ ] Apply allowlist-only sudoers
- [ ] Remove broad sudo grants
- [ ] Test devops can't escalate
