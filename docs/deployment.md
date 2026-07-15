# Production Deployment Guide

This guide walks through deploying Nightdrop with full process isolation. By the end, your AI agent will only be able to drop drafts into a write-only inbox — it cannot read, modify, or delete anything after submission.

## Overview

Production deployment has one goal: the agent can submit drafts, but cannot approve, alter, inspect, or send them.

### Minimum Production Requirements

- Separate Unix service user for Nightdrop, for example `nightdrop`.
- Dedicated inbox group, for example `nightdrop-inbox`.
- Inbox mode `1730`, owned by `nightdrop:nightdrop-inbox`.
- Internal state directories (`pending`, `approved`, `sent`, `denied`, `failed`) mode `0700`, owned by `nightdrop:nightdrop`.
- Provider send credentials readable only by `nightdrop`.
- Telegram approval bot token readable only by `nightdrop`.
- Agent/Hermes runs as a dedicated, non-sudo account with a unique nonzero UID, a same-named private primary group, and no supplementary groups except `nightdrop-inbox` and `nightdrop-mailbox`. Accounts in `sudo`, `wheel`, `docker`, `lxd`, or any other supplementary group are rejected.
- Trusted `getfacl` and `setfacl` executables are installed; both the default audit denial and an explicit read grant must be verifiable.
- `security.enforceProductionPermissions: true` in config.

If any of these are skipped, Nightdrop may still work, but it is no longer enforcing the full structural boundary.

| Component | Runs As | Can Do | Must Not Be Able To Do |
|-----------|---------|--------|-------------------------|
| AI Agent / Hermes | `your-user` | Write files to inbox only | Read/list inbox, read pending/approved/sent, access send credentials, access approval bot token |
| Nightdrop | `nightdrop` | Read inbox, send previews, execute approved drafts | Run arbitrary agent code |
| Telegram Bot | part of `nightdrop` service | Receive approve/deny from authorized humans | Expose token to the agent |

## Phase 1 — Install Managed Service Identities and Runtime

Do **not** pre-create the `nightdrop` user, `nightdrop` primary group, `nightdrop-inbox` group, `nightdrop-mailbox` group, or `/home/nightdrop` before an automated install. The selected agent account must already be a dedicated unprivileged account whose only group is its same-named private primary group; the installer adds only the two Nightdrop capability groups.

Never execute the privileged installer from a checkout writable by the agent. Stage the reviewed source beneath a root-owned, non-group/world-writable ancestor, then run that immutable copy:

```bash
sudo install -d -o root -g root -m 0700 /root/nightdrop-source
sudo rsync -a --delete \
  --exclude .git --exclude .hermes --exclude node_modules --exclude dist \
  ./ /root/nightdrop-source/
sudo chown -R root:root /root/nightdrop-source
sudo chmod -R u=rwX,go=rX /root/nightdrop-source
sudo /root/nightdrop-source/scripts/install-production.sh \
  --agent-user your-user \
  --telegram-user-id YOUR_TELEGRAM_USER_ID
```

The installer records managed identity ownership in a root-owned `0600` marker at `/etc/nightdrop/managed-identities-v1`. On upgrades, it accepts existing Nightdrop identities only when that marker is valid; the service account is a locked system account with a unique system UID, home `/home/nightdrop`, and shell `/usr/sbin/nologin`; its unique primary system group is exactly `nightdrop`; its only effective groups are `nightdrop`, `nightdrop-inbox`, and `nightdrop-mailbox`; the private home is a non-symlink `nightdrop:nightdrop` directory with mode `0700` beneath a root-owned, non-group/world-writable `/home` ancestor that grants other-execute traversal; capability GIDs are unique and are not any user's primary GID; and capability-group members are exactly `nightdrop` plus the selected agent user. Partial or unmanaged target-name/home collisions fail before any group membership is changed.

Production installs are serialized by a root-owned lock at `/run/nightdrop-install.lock`. NSS passwd/group enumeration must succeed, and keyed lookups accept only `getent` status `2` as absence; all other lookup failures abort before mutation. During a fresh install, failure at any identity, membership, home, validation, or marker step triggers bounded rollback of the target user, groups, memberships, home, and marker paths. If the operating system refuses any cleanup operation, the installer reports an incomplete rollback and refuses the next run's partial identity collision rather than silently adopting it.

> ⚠️ Do **not** add your agent's user to the `nightdrop` primary group — that would leak read access to Nightdrop's files.

## Phase 2 — Verify the Filesystem Boundary

The installer stops an already-active service during upgrades, installs lockfile dependencies with root lifecycle scripts disabled, compiles in a staged tree as a one-use unprivileged build account, and swaps in the verified output. The transient user and same-named group are both preflighted, ownership-tracked, removed, and verified absent before deployment continues. It retains the previous runtime, config, systemd unit and enablement, mailbox client, and protected path ownership/modes/ACLs until the upgraded service passes an active-state health check. Any later failure attempts every restore step; the rollback snapshot is deleted only after complete restoration and is retained with an explicit error if any restore operation fails. The persistent `nightdrop` service account never owns source or privileged helpers.

The only application-tree paths writable by `nightdrop` are the dedicated config directory, draft state, and audit log. OAuth setup needs the config directory—not the application root—to be writable so it can atomically replace `config.yaml`.

### Permission Summary

| Path | Owner | Mode | Purpose / agent access |
|------|-------|------|------------------------|
| `/etc/nightdrop/` | `root:root` | `755` | Root-managed installer identity metadata |
| `/etc/nightdrop/managed-identities-v1` | `root:root` | `600` | Proves target users/groups came from a managed Nightdrop install |
| `/home/nightdrop/` | `nightdrop:nightdrop` | `700` | Private credential home; must not be a symlink |
| `/opt/nightdrop/` | `root:root` | `711` | Traverse only; prevents replacement of root-owned helpers |
| `/opt/nightdrop/scripts/` | `root:root` | `755` | Root-invoked helpers, immutable to `nightdrop` and Hermes |
| `/opt/nightdrop/src/` | `root:root` | `700` | Build source, no service/Hermes access |
| `/opt/nightdrop/dist/` | `root:nightdrop` | `750` dirs / `640` files | Service-readable runtime, not service-writable |
| `/opt/nightdrop/node_modules/` | `root:nightdrop` | group read/execute | Service-readable dependencies, not service-writable |
| `/opt/nightdrop/config/` | `nightdrop:nightdrop` | `700` | Private atomic config updates |
| `/opt/nightdrop/config/config.yaml` | `nightdrop:nightdrop` | `600` | Private configuration; Hermes has no access |
| `/opt/nightdrop/drafts/` | `root:root` | `711` | Traverse only |
| `/opt/nightdrop/drafts/inbox/` | `nightdrop:nightdrop-inbox` | `1730` | Hermes **write only** dropbox |
| `/opt/nightdrop/drafts/{pending,approved,sent,denied,failed}/` | `nightdrop:nightdrop` | `700` | Private state |
| `/opt/nightdrop/audit.log` | `nightdrop:nightdrop` | `640` + optional ACL | Hermes/operator read only when explicitly granted |

Verify the critical parent and helper ownership after installation:

```bash
sudo stat -c '%U:%G %a %n' \
  /opt/nightdrop \
  /opt/nightdrop/scripts \
  /opt/nightdrop/scripts/oauth-setup.sh \
  /opt/nightdrop/scripts/smtp-setup.sh \
  /opt/nightdrop/scripts/mailbox-cleanup.sh \
  /opt/nightdrop/config \
  /opt/nightdrop/config/config.yaml
```

## Phase 3 — Credentials

Use a dedicated `pass` store for the `nightdrop` user. This keeps secrets out of environment variables and `/proc/environ`.

Hermes can help prepare the `nightdrop` user and password store, but the human operator should enter provider send credentials from a terminal/SSH session that Hermes is not controlling.

```bash
# Generate GPG key for nightdrop
sudo -u nightdrop bash -c '
  gpg --batch --gen-key <<EOF
Key-Type: RSA
Key-Length: 4096
Subkey-Type: RSA
Subkey-Length: 4096
Name-Real: Nightdrop
Name-Email: nightdrop@localhost
Expire-Date: 0
%no-protection
%commit
EOF
'

# Initialize the empty pass store without invoking pass init.
# The fingerprint is public metadata; no secret is printed.
NIGHTDROP_GPG_FPR=$(sudo -u nightdrop env \
  HOME=/home/nightdrop \
  GNUPGHOME=/home/nightdrop/.gnupg \
  gpg --list-keys --with-colons | awk -F: '/^fpr:/ {print $10; exit}')
test -n "$NIGHTDROP_GPG_FPR"
sudo install -d -m 0700 -o nightdrop -g nightdrop /home/nightdrop/.password-store
printf '%s\n' "$NIGHTDROP_GPG_FPR" | sudo tee /home/nightdrop/.password-store/.gpg-id >/dev/null
sudo chown nightdrop:nightdrop /home/nightdrop/.password-store/.gpg-id
sudo chmod 0600 /home/nightdrop/.password-store/.gpg-id
```

Store the separate approval-bot token first. The OAuth wrapper restarts the service after successful onboarding, so this bootstrap credential must already exist:

```bash
sudo /opt/nightdrop/scripts/configure-provider-secrets.sh telegram
```

Then configure one email provider from your own terminal. Gmail App Password SMTP is the simplest self-hosted path:

```bash
# Do not run these through a Hermes conversation if Hermes must not see send credentials.
sudo /opt/nightdrop/scripts/smtp-setup.sh gmail
# Or use narrower/more involved OAuth authorization:
sudo /opt/nightdrop/scripts/oauth-setup.sh gmail
# or
sudo /opt/nightdrop/scripts/oauth-setup.sh outlook
# or
sudo /opt/nightdrop/scripts/oauth-setup.sh zoho
```

The SMTP helper verifies Gmail authentication over certificate-verified TLS, stores one versioned App Password directly in the `nightdrop` `pass` store, atomically writes only its `${PASS:...}` reference plus safe sender metadata, and restarts the service. This path requires Google 2-Step Verification and App Password availability; it is simpler but the credential is broader than `gmail.send` OAuth. See [smtp-onboarding.md](smtp-onboarding.md).

That installed App Password can also power the fixed-scope, human-gated unread cleanup helper:

```bash
sudo /opt/nightdrop/scripts/mailbox-cleanup.sh gmail
```

The helper shows only unread Spam/Trash counts and requires `MARK READ` before adding `\Seen` to the approved UID snapshot. It does not restart the service or delete, move, empty, fetch, or display messages. See [mailbox-cleanup.md](mailbox-cleanup.md).

The OAuth helper runs as `nightdrop` with a clean environment, stores refresh credentials directly in its `pass` store, verifies the authenticated sender/account, atomically writes only versioned `${PASS:...}` references to private config, and restarts the service. Gmail, Outlook, and Zoho use a loopback SSH tunnel by default; Outlook offers an explicit higher-risk `--device-code` fallback. See [oauth-onboarding.md](oauth-onboarding.md).

See [credential-handoff.md](credential-handoff.md) for operator responsibilities and the hard boundary.

## Phase 4 — Production Config (Manual Install Reference Only)

> **If you used `scripts/install-production.sh`, skip this phase.** The installer created the private config and the SMTP/OAuth onboarding helper updated it. Never replace `config.yaml` with this example after onboarding; doing so would discard the verified sender metadata and versioned pass references.

```bash
sudo -u nightdrop tee /opt/nightdrop/config/config.yaml > /dev/null << 'EOF'
telegram:
  botToken: "${PASS:nightdrop/telegram-bot-token}"
  allowedUsers: [YOUR_TELEGRAM_USER_ID]

watch:
  directory: "/opt/nightdrop/drafts/inbox"
  pollIntervalMs: 2000

providers:
  gmail-smtp:
    type: "email-smtp"
    host: "smtp.gmail.com"
    port: 465
    tlsMode: "implicit"
    username: "you@gmail.com"
    password: "${PASS:nightdrop/smtp-password-VERSION}"
    fromAddress: "you@gmail.com"
    displayName: "Your Name"

  gmail:
    type: "email-gmail"
    clientId: "${PASS:nightdrop/google-client-id}"
    # No clientSecret for Desktop/public-client onboarding.
    refreshToken: "${PASS:nightdrop/google-refresh-token}"
    fromAddress: "you@gmail.com"
    displayName: "Your Name"

  outlook:
    type: "email-outlook"
    clientId: "${PASS:nightdrop/microsoft-client-id}"
    # No clientSecret for recommended public-client PKCE/device flows.
    refreshToken: "${PASS:nightdrop/microsoft-refresh-token}"
    refreshTokenKey: "nightdrop/microsoft-refresh-token"
    tenantId: "common"
    fromAddress: "you@outlook.com"
    displayName: "Your Name"

  zoho:
    type: "email-zoho"
    clientId: "${PASS:nightdrop/zoho-client-id}"
    clientSecret: "${PASS:nightdrop/zoho-client-secret}"
    refreshToken: "${PASS:nightdrop/zoho-refresh-token}"
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
  logFile: "/opt/nightdrop/audit.log"
EOF

sudo chmod 600 /opt/nightdrop/config/config.yaml
```

## Phase 5 — systemd Service (Manual Install Reference Only)

> **If you used the production installer, do not replace its hardened unit.** The installer already wrote the unit and the SMTP/OAuth wrapper started or restarted it after onboarding. Use the commands below only for a fully manual installation.

```bash
sudo tee /etc/systemd/system/nightdrop.service > /dev/null << 'EOF'
[Unit]
Description=Nightdrop — Deterministic Approval Layer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nightdrop
Group=nightdrop
WorkingDirectory=/opt/nightdrop
ExecStart=/usr/bin/node /opt/nightdrop/dist/index.js
Environment=NIGHTDROP_CONFIG=/opt/nightdrop/config/config.yaml
Environment=PASSWORD_STORE_DIR=/home/nightdrop/.password-store
Environment=GNUPGHOME=/home/nightdrop/.gnupg

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
ReadWritePaths=/opt/nightdrop/drafts /opt/nightdrop/audit.log /home/nightdrop/.gnupg /home/nightdrop/.password-store

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nightdrop

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable nightdrop
sudo systemctl start nightdrop
```

Verify it's running:

```bash
sudo systemctl status nightdrop --no-pager
sudo journalctl -u nightdrop -f
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
# Only allow checking Nightdrop status and viewing logs
Defaults:your-user env_reset,use_pty
Cmnd_Alias SAFE_OPS = /usr/bin/systemctl status nightdrop.service, \
                       /usr/bin/journalctl -u nightdrop.service, \
                       /usr/bin/journalctl -u nightdrop.service -n *, \
                       /usr/bin/journalctl -u nightdrop.service -f

your-user ALL=(root) NOPASSWD: SAFE_OPS
```

Then remove any existing file granting `ALL=(ALL) ALL`.

## Dropping Drafts From Your Agent

Your agent writes to the inbox using the shared group:

```bash
# If your system has `sg` (switch group):
sg nightdrop-inbox -c 'cat > /opt/nightdrop/drafts/inbox/my-draft.json << EOF
{
  "id": "...",
  "type": "email",
  ...
}
EOF'
```

The file lands in the dropbox. Nightdrop picks it up, moves it to `pending/`, and sends you a Telegram preview. Your agent never sees it again.

## Verifying Isolation

Run these as your agent's user (no sudo):

```bash
# Should fail — can't list the Nightdrop directory
ls /opt/nightdrop/
# Expected: Permission denied

# Should fail — can't read inbox
ls /opt/nightdrop/drafts/inbox/
# Expected: Permission denied

# Should succeed — can write to inbox
echo '{}' > /opt/nightdrop/drafts/inbox/test.json
# Expected: Success (Nightdrop will reject it as malformed and move to failed/)

# Should fail — can't read pending, approved, sent, etc.
ls /opt/nightdrop/drafts/pending/
# Expected: Permission denied

# Should succeed — can read audit log (if ACL set)
cat /opt/nightdrop/audit.log
# Expected: JSON audit entries
```
