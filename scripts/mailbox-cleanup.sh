#!/bin/bash
# mailbox-cleanup.sh - human-approved Gmail Spam/Trash unread-flag cleanup.
# Run only from the installed root-owned path in a human-controlled local/SSH terminal.

set -euo pipefail

readonly TRUSTED_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH="$TRUSTED_PATH"

SERVICE_USER="agentgate"
SCRIPT_PATH="$(/usr/bin/readlink -f -- "${BASH_SOURCE[0]}")"
INSTALL_DIR="$(cd "$(/usr/bin/dirname -- "$SCRIPT_PATH")/.." && pwd -P)"
CONFIG_PATH="$INSTALL_DIR/config/config.yaml"

usage() {
  cat <<USAGE
Usage: sudo $0 gmail

Previews unread Gmail Spam and Trash counts, then requires the exact phrase
MARK READ before changing only the snapshotted messages. Nothing is deleted,
moved, archived, or emptied. The Gmail App Password stays inside agentgate.
USAGE
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

assert_trusted_ancestor_chain() {
  local current="$1" owner mode permissions
  while [[ "$current" != "/" ]]; do
    read -r owner mode < <(/usr/bin/stat -Lc '%U %a' -- "$current")
    permissions=$((8#$mode))
    if [[ "$owner" != "root" ]] || (( (permissions & 8#022) != 0 )); then
      echo "Refusing non-root-owned or writable privileged path: $current" >&2
      return 1
    fi
    current="$(/usr/bin/dirname -- "$current")"
  done
}

resolve_trusted_executable() {
  local name="$1" resolved canonical
  resolved="$(command -v -- "$name" || true)"
  [[ -n "$resolved" ]] || return 1
  canonical="$(/usr/bin/readlink -f -- "$resolved")"
  [[ -f "$canonical" && -x "$canonical" ]] || return 1
  assert_trusted_ancestor_chain "$canonical" || return 1
  printf '%s\n' "$canonical"
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi
if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo from a human-controlled terminal." >&2
  exit 1
fi
if [[ ! -t 0 || ! -t 1 ]]; then
  echo "Refusing non-interactive mailbox cleanup; a human TTY is required." >&2
  exit 1
fi
if [[ $# -ne 1 || $1 != "gmail" ]]; then
  usage >&2
  exit 2
fi

validate_trusted_path
assert_trusted_ancestor_chain "$SCRIPT_PATH"
if ! /usr/bin/id -- "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Missing service user: $SERVICE_USER" >&2
  exit 1
fi
if ! NODE_BIN="$(resolve_trusted_executable node)"; then
  echo "A trusted root-owned node executable is required on the fixed system PATH." >&2
  exit 1
fi
if ! RUNUSER_BIN="$(resolve_trusted_executable runuser)"; then
  echo "A trusted root-owned runuser executable is required on the fixed system PATH." >&2
  exit 1
fi
if ! PASS_BIN="$(resolve_trusted_executable pass)"; then
  echo "A trusted root-owned pass executable is required on the fixed system PATH." >&2
  exit 1
fi
if ! ENV_BIN="$(resolve_trusted_executable env)"; then
  echo "A trusted root-owned env executable is required on the fixed system PATH." >&2
  exit 1
fi
if [[ ! -f "$INSTALL_DIR/dist/mailbox-cleanup.js" || -L "$INSTALL_DIR/dist/mailbox-cleanup.js" ]]; then
  echo "Mailbox cleanup executable is missing or unsafe. Reinstall agent-gate first." >&2
  exit 1
fi
assert_trusted_ancestor_chain "$INSTALL_DIR/dist/mailbox-cleanup.js"
if [[ ! -f "$CONFIG_PATH" || -L "$CONFIG_PATH" ]]; then
  echo "Agent-gate config is missing or unsafe: $CONFIG_PATH" >&2
  exit 1
fi

"$RUNUSER_BIN" -u "$SERVICE_USER" -- "$ENV_BIN" -i \
  HOME="/home/$SERVICE_USER" \
  PATH="$TRUSTED_PATH" \
  LANG="C.UTF-8" \
  LC_ALL="C.UTF-8" \
  TERM="dumb" \
  GNUPGHOME="/home/$SERVICE_USER/.gnupg" \
  PASSWORD_STORE_DIR="/home/$SERVICE_USER/.password-store" \
  AGENT_GATE_PASS_BIN="$PASS_BIN" \
  AGENT_GATE_AUDIT_LOG="$INSTALL_DIR/audit.log" \
  "$NODE_BIN" "$INSTALL_DIR/dist/mailbox-cleanup.js" "gmail" --config "$CONFIG_PATH"
