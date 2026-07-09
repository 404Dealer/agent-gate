#!/usr/bin/env bash
# install-production.sh — install agent-gate with a write-only inbox for Hermes/agents.
# Run as root from a built checkout, e.g.:
#   sudo scripts/install-production.sh --agent-user spacex --telegram-user-id 2061243435

set -euo pipefail

AGENT_USER="${SUDO_USER:-${USER}}"
TELEGRAM_USER_ID=""
INSTALL_DIR="/opt/agent-gate"
SERVICE_USER="agentgate"
INBOX_GROUP="agentgate-inbox"

usage() {
  cat <<USAGE
Usage: sudo $0 --telegram-user-id ID [--agent-user USER] [--install-dir /opt/agent-gate]

Creates:
  - service user:        $SERVICE_USER
  - write-only group:    $INBOX_GROUP
  - installation root:   $INSTALL_DIR
  - systemd service:     agent-gate.service

Secrets are left as \\${PASS:...} placeholders in config.yaml; add them to the
agentgate user's pass store before starting the service for a real provider.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-user) AGENT_USER="${2:?}"; shift 2 ;;
    --telegram-user-id) TELEGRAM_USER_ID="${2:?}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi
if [[ -z "$TELEGRAM_USER_ID" ]]; then
  echo "--telegram-user-id is required." >&2
  exit 2
fi
if ! id "$AGENT_USER" >/dev/null 2>&1; then
  echo "Agent user does not exist: $AGENT_USER" >&2
  exit 2
fi

id "$SERVICE_USER" >/dev/null 2>&1 || useradd -r -m -d /home/$SERVICE_USER -s /usr/sbin/nologin "$SERVICE_USER"
getent group "$INBOX_GROUP" >/dev/null || groupadd --system "$INBOX_GROUP"
usermod -aG "$INBOX_GROUP" "$SERVICE_USER"
usermod -aG "$INBOX_GROUP" "$AGENT_USER"

mkdir -p "$INSTALL_DIR"/drafts/{inbox,pending,approved,sent,denied,failed}
rsync -a --delete --exclude .git --exclude node_modules --exclude dist ./ "$INSTALL_DIR"/
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

sudo -u "$SERVICE_USER" bash -lc "cd '$INSTALL_DIR' && npm ci && npm run build"

chmod 711 "$INSTALL_DIR" "$INSTALL_DIR/drafts"
chmod 700 "$INSTALL_DIR/src" "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules"
chown "$SERVICE_USER:$INBOX_GROUP" "$INSTALL_DIR/drafts/inbox"
chmod 1730 "$INSTALL_DIR/drafts/inbox"
for dir in pending approved sent denied failed; do
  chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/drafts/$dir"
  chmod 700 "$INSTALL_DIR/drafts/$dir"
done

touch "$INSTALL_DIR/audit.log"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/audit.log"
chmod 640 "$INSTALL_DIR/audit.log"
if command -v setfacl >/dev/null 2>&1; then
  setfacl -m "u:$AGENT_USER:r" "$INSTALL_DIR/audit.log" || true
fi

if [[ ! -f "$INSTALL_DIR/config.yaml" ]]; then
  cat > "$INSTALL_DIR/config.yaml" <<EOF
telegram:
  botToken: "\${PASS:agent-gate/telegram-bot-token}"
  allowedUsers: [$TELEGRAM_USER_ID]

watch:
  directory: "$INSTALL_DIR/drafts/inbox"
  pollIntervalMs: 2000

approval:
  bodyPreviewChars: 2000
  allowTruncatedApproval: false

security:
  enforceProductionPermissions: true

providers:
  log:
    type: "log-only"
    fromAddress: "log-only@example.invalid"

defaults:
  provider: "log"
  timezone: "UTC"
  autoDeleteAfterDays: 30

audit:
  enabled: true
  logFile: "$INSTALL_DIR/audit.log"
EOF
fi
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/config.yaml"
chmod 600 "$INSTALL_DIR/config.yaml"

cat > /etc/systemd/system/agent-gate.service <<EOF
[Unit]
Description=agent-gate — Deterministic Approval Layer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/dist/index.js
Environment=AGENT_GATE_CONFIG=$INSTALL_DIR/config.yaml
Environment=PASSWORD_STORE_DIR=/home/$SERVICE_USER/.password-store
Environment=GNUPGHOME=/home/$SERVICE_USER/.gnupg
Restart=on-failure
RestartSec=10
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
ReadWritePaths=$INSTALL_DIR/drafts $INSTALL_DIR/audit.log /home/$SERVICE_USER/.gnupg /home/$SERVICE_USER/.password-store
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agent-gate

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable agent-gate >/dev/null

cat <<DONE
Installed agent-gate to $INSTALL_DIR.

Next steps:
1. Configure secrets for the $SERVICE_USER user, or keep provider=log for dry-run.
2. Start: sudo systemctl start agent-gate
3. Verify: sudo journalctl -u agent-gate -n 50 --no-pager
4. Re-login $AGENT_USER so membership in $INBOX_GROUP is active.

Hermes/agent dropbox path:
  $INSTALL_DIR/drafts/inbox
DONE
