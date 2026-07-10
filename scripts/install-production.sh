#!/usr/bin/env bash
# install-production.sh — install agent-gate with a write-only inbox for Hermes/agents.
# Run as root from a reviewed checkout, e.g.:
#   sudo scripts/install-production.sh --agent-user spacex --telegram-user-id 2061243435

set -euo pipefail

readonly TRUSTED_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH="$TRUSTED_PATH"

AGENT_USER="${SUDO_USER:-${USER:-}}"
TELEGRAM_USER_ID=""
INSTALL_DIR="/opt/agent-gate"
SERVICE_USER="agentgate"
INBOX_GROUP="agentgate-inbox"
SERVICE_NAME="agent-gate.service"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

usage() {
  cat <<USAGE
Usage: sudo $0 --telegram-user-id ID [--agent-user USER] [--install-dir /opt/agent-gate]

Creates:
  - service user:        $SERVICE_USER
  - write-only group:    $INBOX_GROUP
  - root-owned app root: $INSTALL_DIR
  - private config dir:  $INSTALL_DIR/config
  - systemd service:     $SERVICE_NAME

Secrets are left as \${PASS:...} placeholders in config/config.yaml; add them to
the agentgate user's pass store before starting the service for a real provider.
USAGE
}

validate_agent_user() {
  [[ "$1" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]
}

validate_telegram_user_id() {
  local value="$1"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || return 1
  if (( ${#value} > 16 )); then
    return 1
  fi
  if (( ${#value} == 16 )) && [[ "$value" > "9007199254740991" ]]; then
    return 1
  fi
}

validate_install_dir() {
  local value="$1"
  [[ "$value" =~ ^/opt/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || return 1
  [[ "$(/usr/bin/realpath -m -- "$value")" == "$value" ]]
}

validate_trusted_path() {
  local directory owner mode permissions
  local -a directories=()
  IFS=':' read -r -a directories <<< "$TRUSTED_PATH"
  for directory in "${directories[@]}"; do
    [[ -d "$directory" ]] || continue
    read -r owner mode < <(/usr/bin/stat -Lc '%U %a' -- "$directory")
    permissions=$((8#$mode))
    if [[ "$owner" != "root" ]] || (( (permissions & 8#022) != 0 )); then
      echo "Refusing untrusted executable path directory: $directory" >&2
      return 1
    fi
  done
}

resolve_trusted_executable() {
  local name="$1" resolved canonical current owner mode permissions
  resolved="$(command -v -- "$name" || true)"
  [[ -n "$resolved" ]] || return 1
  canonical="$(/usr/bin/readlink -f -- "$resolved")"
  [[ -f "$canonical" && -x "$canonical" ]] || return 1

  current="$canonical"
  while [[ "$current" != "/" ]]; do
    read -r owner mode < <(/usr/bin/stat -Lc '%U %a' -- "$current")
    permissions=$((8#$mode))
    if [[ "$owner" != "root" ]] || (( (permissions & 8#022) != 0 )); then
      echo "Refusing untrusted executable or ancestor: $current" >&2
      return 1
    fi
    current="$(/usr/bin/dirname -- "$current")"
  done
  printf '%s\n' "$canonical"
}

sync_application_tree() {
  local ownership="${1:-root:root}"
  rsync -a --delete --chown="$ownership" \
    --exclude /.git/ \
    --exclude /.hermes/ \
    --exclude '/.rollback-*/' \
    --exclude /node_modules/ \
    --exclude /dist/ \
    --exclude /config/ \
    --exclude /config.yaml \
    --exclude /audit.log \
    --exclude /drafts/ \
    "$SOURCE_DIR"/ "$INSTALL_DIR"/
}

main() {
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
if ! validate_telegram_user_id "$TELEGRAM_USER_ID"; then
  echo "--telegram-user-id must be a positive decimal integer within JavaScript's safe range." >&2
  exit 2
fi
if ! validate_agent_user "$AGENT_USER" || [[ "$AGENT_USER" == "root" ]]; then
  echo "--agent-user must name an existing non-root local Unix account." >&2
  exit 2
fi
if ! id -- "$AGENT_USER" >/dev/null 2>&1; then
  echo "Agent user does not exist: $AGENT_USER" >&2
  exit 2
fi
if ! validate_install_dir "$INSTALL_DIR"; then
  echo "--install-dir must be a canonical absolute path below /opt using safe path characters." >&2
  exit 2
fi
validate_trusted_path || exit 1

if [[ ! -f "$SOURCE_DIR/package.json" || ! -f "$SOURCE_DIR/package-lock.json" || ! -d "$SOURCE_DIR/src" ]]; then
  echo "Installer source is not a complete agent-gate checkout: $SOURCE_DIR" >&2
  exit 1
fi
source_symlink="$(find "$SOURCE_DIR" \
  \( -path "$SOURCE_DIR/.git" -o -path "$SOURCE_DIR/node_modules" -o -path "$SOURCE_DIR/dist" \) -prune -o \
  -type l -print -quit)"
if [[ -n "$source_symlink" ]]; then
  echo "Installer source contains an unsupported symbolic link: $source_symlink" >&2
  exit 1
fi
if [[ "$INSTALL_DIR" == "$SOURCE_DIR" ]]; then
  echo "Run the installer from a separate reviewed checkout, not from the live install tree." >&2
  exit 2
fi

if ! NODE_BIN="$(resolve_trusted_executable node)" \
  || ! NPM_BIN="$(resolve_trusted_executable npm)" \
  || ! PASS_BIN="$(resolve_trusted_executable pass)"; then
  echo "Trusted root-owned node, npm, and pass executables are required on the fixed system PATH." >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 20 )); then
  echo "agent-gate requires Node.js 20 or newer." >&2
  exit 1
fi

id "$SERVICE_USER" >/dev/null 2>&1 || useradd -r -m -d /home/$SERVICE_USER -s /usr/sbin/nologin "$SERVICE_USER"
getent group "$INBOX_GROUP" >/dev/null || groupadd --system "$INBOX_GROUP"
usermod -aG "$INBOX_GROUP" "$SERVICE_USER"
usermod -aG "$INBOX_GROUP" "$AGENT_USER"
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
CONFIG_DIR="$INSTALL_DIR/config"
BUILD_USER="agentgate-build-$$"
BUILD_HOME=""
BUILD_ROOT=""
ROLLBACK_ROOT=""
PREVIOUS_DIST=""
PREVIOUS_MODULES=""
PREVIOUS_CONFIG=""
PREVIOUS_LEGACY_CONFIG=""
PREVIOUS_UNIT=""
RUNTIME_SWAPPED=false
CONFIG_TOUCHED=false
UNIT_WRITTEN=false
UNIT_PATH="/etc/systemd/system/$SERVICE_NAME"

cleanup_builder() {
  if id -- "$BUILD_USER" >/dev/null 2>&1; then
    pkill -KILL -u "$BUILD_USER" >/dev/null 2>&1 || true
    userdel "$BUILD_USER" >/dev/null 2>&1 || true
  fi
  [[ -z "$BUILD_HOME" ]] || rm -rf -- "$BUILD_HOME"
  [[ -z "$BUILD_ROOT" ]] || rm -rf -- "$BUILD_ROOT"
  BUILD_HOME=""
  BUILD_ROOT=""
}

SERVICE_WAS_ACTIVE=false
if systemctl is-active --quiet "$SERVICE_NAME"; then
  SERVICE_WAS_ACTIVE=true
  systemctl stop "$SERVICE_NAME"
fi

restore_previous_deployment() {
  local status=$?
  trap - EXIT
  if [[ $status -ne 0 ]]; then
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    if [[ "$RUNTIME_SWAPPED" == true ]]; then
      rm -rf -- "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules"
      [[ -z "$PREVIOUS_DIST" || ! -e "$PREVIOUS_DIST" ]] || mv "$PREVIOUS_DIST" "$INSTALL_DIR/dist"
      [[ -z "$PREVIOUS_MODULES" || ! -e "$PREVIOUS_MODULES" ]] || mv "$PREVIOUS_MODULES" "$INSTALL_DIR/node_modules"
    fi
    if [[ "$CONFIG_TOUCHED" == true ]]; then
      rm -f -- "$CONFIG_DIR/config.yaml" "$INSTALL_DIR/config.yaml"
      [[ -z "$PREVIOUS_CONFIG" || ! -e "$PREVIOUS_CONFIG" ]] || cp -a "$PREVIOUS_CONFIG" "$CONFIG_DIR/config.yaml"
      [[ -z "$PREVIOUS_LEGACY_CONFIG" || ! -e "$PREVIOUS_LEGACY_CONFIG" ]] || cp -a "$PREVIOUS_LEGACY_CONFIG" "$INSTALL_DIR/config.yaml"
    fi
    if [[ "$UNIT_WRITTEN" == true ]]; then
      if [[ -n "$PREVIOUS_UNIT" && -e "$PREVIOUS_UNIT" ]]; then
        cp -a "$PREVIOUS_UNIT" "$UNIT_PATH"
      else
        rm -f -- "$UNIT_PATH"
      fi
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
  fi
  cleanup_builder
  [[ -z "$ROLLBACK_ROOT" ]] || rm -rf -- "$ROLLBACK_ROOT"
  if [[ $status -ne 0 && "$SERVICE_WAS_ACTIVE" == true ]]; then
    systemctl start "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap restore_previous_deployment EXIT

if [[ -L "$INSTALL_DIR" ]]; then
  echo "Refusing symbolic link at protected install path: $INSTALL_DIR" >&2
  exit 1
fi
mkdir -p "$INSTALL_DIR"
chown root:root "$INSTALL_DIR"
chmod 711 "$INSTALL_DIR"
protected_paths=(
  "$CONFIG_DIR"
  "$CONFIG_DIR/config.yaml"
  "$INSTALL_DIR/config.yaml"
  "$INSTALL_DIR/drafts"
  "$INSTALL_DIR/drafts/inbox"
  "$INSTALL_DIR/drafts/pending"
  "$INSTALL_DIR/drafts/approved"
  "$INSTALL_DIR/drafts/sent"
  "$INSTALL_DIR/drafts/denied"
  "$INSTALL_DIR/drafts/failed"
  "$INSTALL_DIR/audit.log"
)
for protected_path in "${protected_paths[@]}"; do
  if [[ -L "$protected_path" ]]; then
    echo "Refusing symbolic link at protected install path: $protected_path" >&2
    exit 1
  fi
done

ROLLBACK_ROOT="$(mktemp -d "$INSTALL_DIR/.rollback-XXXXXXXX")"
chmod 700 "$ROLLBACK_ROOT"
if [[ -f "$CONFIG_DIR/config.yaml" ]]; then
  PREVIOUS_CONFIG="$ROLLBACK_ROOT/config.yaml"
  cp -a "$CONFIG_DIR/config.yaml" "$PREVIOUS_CONFIG"
fi
if [[ -f "$INSTALL_DIR/config.yaml" ]]; then
  PREVIOUS_LEGACY_CONFIG="$ROLLBACK_ROOT/legacy-config.yaml"
  cp -a "$INSTALL_DIR/config.yaml" "$PREVIOUS_LEGACY_CONFIG"
fi
if [[ -f "$UNIT_PATH" ]]; then
  PREVIOUS_UNIT="$ROLLBACK_ROOT/agent-gate.service"
  cp -a "$UNIT_PATH" "$PREVIOUS_UNIT"
fi
PREVIOUS_DIST="$ROLLBACK_ROOT/previous-dist"
PREVIOUS_MODULES="$ROLLBACK_ROOT/previous-node-modules"

mkdir -p "$CONFIG_DIR" "$INSTALL_DIR"/drafts/{inbox,pending,approved,sent,denied,failed}
sync_application_tree

# rsync applies root ownership only to copied application code. Excluded config,
# runtime state, and the previous dist/node_modules retain their existing owners
# until a verified replacement is ready.
chmod 711 "$INSTALL_DIR"
chown root:root "$INSTALL_DIR/scripts"
chmod 755 "$INSTALL_DIR/scripts"
chown root:root \
  "$INSTALL_DIR/scripts/oauth-setup.sh" \
  "$INSTALL_DIR/scripts/smtp-setup.sh" \
  "$INSTALL_DIR/scripts/configure-provider-secrets.sh" \
  "$INSTALL_DIR/scripts/install-production.sh"
chmod 755 \
  "$INSTALL_DIR/scripts/oauth-setup.sh" \
  "$INSTALL_DIR/scripts/smtp-setup.sh" \
  "$INSTALL_DIR/scripts/configure-provider-secrets.sh" \
  "$INSTALL_DIR/scripts/install-production.sh"

# Build a complete replacement runtime outside the live dist/node_modules. npm
# lifecycle hooks stay disabled as root; TypeScript compilation runs as a
# one-use account with no access to agentgate's config or credential store.
BUILD_ROOT="$(mktemp -d "$INSTALL_DIR/.build-XXXXXXXX")"
BUILD_HOME="$(mktemp -d /tmp/agent-gate-build-home.XXXXXXXX)"
install -m 0644 \
  "$SOURCE_DIR/package.json" \
  "$SOURCE_DIR/package-lock.json" \
  "$SOURCE_DIR/tsconfig.json" \
  "$BUILD_ROOT/"
cp -a "$SOURCE_DIR/src" "$BUILD_ROOT/src"
"$NPM_BIN" ci --ignore-scripts --prefix "$BUILD_ROOT"

useradd -r -M -U -d "$BUILD_HOME" -s /usr/sbin/nologin "$BUILD_USER"
BUILD_GROUP="$(id -gn "$BUILD_USER")"
chown root:"$BUILD_GROUP" "$BUILD_ROOT"
chmod 750 "$BUILD_ROOT"
chown -hR root:"$BUILD_GROUP" \
  "$BUILD_ROOT/package.json" \
  "$BUILD_ROOT/package-lock.json" \
  "$BUILD_ROOT/tsconfig.json" \
  "$BUILD_ROOT/src" \
  "$BUILD_ROOT/node_modules"
chmod -R u=rwX,g=rX,o= \
  "$BUILD_ROOT/package.json" \
  "$BUILD_ROOT/package-lock.json" \
  "$BUILD_ROOT/tsconfig.json" \
  "$BUILD_ROOT/src" \
  "$BUILD_ROOT/node_modules"
install -d -o "$BUILD_USER" -g "$BUILD_GROUP" -m 700 "$BUILD_ROOT/dist"
chown "$BUILD_USER:$BUILD_GROUP" "$BUILD_HOME"
chmod 700 "$BUILD_HOME"
runuser -u "$BUILD_USER" -- env -i \
  HOME="$BUILD_HOME" \
  PATH="$TRUSTED_PATH" \
  "$NPM_BIN" --prefix "$BUILD_ROOT" run build
pkill -KILL -u "$BUILD_USER" >/dev/null 2>&1 || true
userdel "$BUILD_USER"

build_symlink="$(find "$BUILD_ROOT/dist" -type l -print -quit)"
if [[ -n "$build_symlink" ]]; then
  echo "Refusing symbolic link in compiled runtime: $build_symlink" >&2
  exit 1
fi
chown -hR root:"$SERVICE_GROUP" "$BUILD_ROOT/dist" "$BUILD_ROOT/node_modules"
chmod -R u=rwX,g=rX,o= "$BUILD_ROOT/dist" "$BUILD_ROOT/node_modules"

RUNTIME_SWAPPED=true
[[ ! -e "$INSTALL_DIR/dist" ]] || mv "$INSTALL_DIR/dist" "$PREVIOUS_DIST"
[[ ! -e "$INSTALL_DIR/node_modules" ]] || mv "$INSTALL_DIR/node_modules" "$PREVIOUS_MODULES"
mv "$BUILD_ROOT/node_modules" "$INSTALL_DIR/node_modules"
mv "$BUILD_ROOT/dist" "$INSTALL_DIR/dist"
cleanup_builder

chown -hR root:root "$INSTALL_DIR/src"
chmod -R u=rwX,go= "$INSTALL_DIR/src"

# Migrate the legacy single-file location once. The dedicated directory is the
# only app-tree location writable by agentgate, which preserves atomic renames
# without making the root-owned scripts replaceable.
CONFIG_TOUCHED=true
mkdir -p "$CONFIG_DIR"
if [[ -f "$INSTALL_DIR/config.yaml" ]]; then
  if [[ -e "$CONFIG_DIR/config.yaml" ]]; then
    echo "Both legacy and current config paths exist; refusing ambiguous migration." >&2
    exit 1
  fi
  mv "$INSTALL_DIR/config.yaml" "$CONFIG_DIR/config.yaml"
fi
if [[ ! -f "$CONFIG_DIR/config.yaml" ]]; then
  cat > "$CONFIG_DIR/config.yaml" <<EOF
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
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
chmod 600 "$CONFIG_DIR/config.yaml"

chmod 711 "$INSTALL_DIR/drafts"
chown "$SERVICE_USER:$INBOX_GROUP" "$INSTALL_DIR/drafts/inbox"
chmod 1730 "$INSTALL_DIR/drafts/inbox"
for dir in pending approved sent denied failed; do
  chown "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/drafts/$dir"
  chmod 700 "$INSTALL_DIR/drafts/$dir"
done

touch "$INSTALL_DIR/audit.log"
chown "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/audit.log"
chmod 640 "$INSTALL_DIR/audit.log"
if command -v setfacl >/dev/null 2>&1; then
  setfacl -m "u:$AGENT_USER:r" "$INSTALL_DIR/audit.log" || true
fi

UNIT_WRITTEN=true
cat > "$UNIT_PATH" <<EOF
[Unit]
Description=agent-gate — Deterministic Approval Layer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/dist/index.js
Environment=AGENT_GATE_CONFIG=$CONFIG_DIR/config.yaml
Environment=AGENT_GATE_PASS_BIN=$PASS_BIN
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
systemctl enable "$SERVICE_NAME" >/dev/null
if [[ "$SERVICE_WAS_ACTIVE" == true ]]; then
  systemctl start "$SERVICE_NAME"
  if ! systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "Upgraded service failed its active-state health check; restoring the previous deployment." >&2
    exit 1
  fi
fi
rm -rf -- "$ROLLBACK_ROOT"
ROLLBACK_ROOT=""
trap - EXIT

cat <<DONE
Installed agent-gate to $INSTALL_DIR.
Private config: $CONFIG_DIR/config.yaml

Next steps:
1. Configure secrets for the $SERVICE_USER user, or keep provider=log for dry-run.
2. Start: sudo systemctl start $SERVICE_NAME
3. Verify: sudo journalctl -u $SERVICE_NAME -n 50 --no-pager
4. Re-login $AGENT_USER so membership in $INBOX_GROUP is active.

Hermes/agent dropbox path:
  $INSTALL_DIR/drafts/inbox
DONE
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
