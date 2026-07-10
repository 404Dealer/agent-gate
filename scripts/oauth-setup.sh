#!/usr/bin/env bash
# oauth-setup.sh — human-only browser OAuth onboarding (device code is Outlook fallback only).
# Run only from the installed root-owned path in a human-controlled local/SSH terminal.

set -euo pipefail

readonly TRUSTED_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH="$TRUSTED_PATH"

SERVICE_USER="agentgate"
SERVICE_NAME="agent-gate.service"
SCRIPT_PATH="$(/usr/bin/readlink -f -- "${BASH_SOURCE[0]}")"
INSTALL_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd -P)"
CONFIG_PATH="$INSTALL_DIR/config/config.yaml"

usage() {
  cat <<USAGE
Usage: sudo $0 <gmail|outlook|zoho> [--port PORT] [--device-code]

This wrapper:
  1. verifies that its installed path is root-owned and not writable by non-root users;
  2. drops privileges to the isolated $SERVICE_USER user with a clean environment;
  3. runs PKCE browser OAuth in a real human TTY;
  4. permits --device-code only as an explicit Outlook fallback;
  5. stores refresh credentials directly in the $SERVICE_USER pass store;
  6. writes only \${PASS:...} references to config.yaml;
  7. restarts $SERVICE_NAME after successful onboarding and waits for stable health.

No secret/token command-line options exist.
USAGE
}

assert_root_owned_path() {
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
  assert_root_owned_path "$canonical" || return 1
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
  echo "Refusing non-interactive OAuth setup; a human TTY is required." >&2
  exit 1
fi
if [[ $# -lt 1 ]]; then
  usage >&2
  exit 2
fi
assert_root_owned_path "$SCRIPT_PATH"
if ! id -- "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Missing service user: $SERVICE_USER" >&2
  exit 1
fi
if ! NODE_BIN="$(resolve_trusted_executable node)"; then
  echo "A trusted root-owned node executable is required on the fixed system PATH." >&2
  exit 1
fi
if [[ ! -f "$INSTALL_DIR/dist/oauth-setup.js" || -L "$INSTALL_DIR/dist/oauth-setup.js" ]]; then
  echo "OAuth setup executable is missing or unsafe. Reinstall agent-gate first." >&2
  exit 1
fi
if [[ ! -f "$CONFIG_PATH" || -L "$CONFIG_PATH" ]]; then
  echo "Agent-gate config is missing or unsafe: $CONFIG_PATH" >&2
  exit 1
fi

runuser -u "$SERVICE_USER" -- env -i \
  HOME="/home/$SERVICE_USER" \
  PATH="$TRUSTED_PATH" \
  LANG="C.UTF-8" \
  LC_ALL="C.UTF-8" \
  TERM="dumb" \
  GNUPGHOME="/home/$SERVICE_USER/.gnupg" \
  PASSWORD_STORE_DIR="/home/$SERVICE_USER/.password-store" \
  "$NODE_BIN" "$INSTALL_DIR/dist/oauth-setup.js" "$@" --config "$CONFIG_PATH"

systemctl restart "$SERVICE_NAME"
healthy_checks=0
for _ in {1..10}; do
  sleep 1
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    healthy_checks=$((healthy_checks + 1))
    if (( healthy_checks >= 3 )); then
      break
    fi
  else
    healthy_checks=0
  fi
done
if (( healthy_checks < 3 )); then
  echo "OAuth data was stored, but $SERVICE_NAME did not remain active." >&2
  echo "Inspect: sudo journalctl -u $SERVICE_NAME -n 100 --no-pager" >&2
  exit 1
fi

echo "$SERVICE_NAME restarted successfully. Provider tokens were never exposed to the invoking user or Hermes."
