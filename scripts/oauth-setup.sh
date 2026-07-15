#!/usr/bin/env bash
# oauth-setup.sh — human-only browser OAuth onboarding (device code is Outlook fallback only).
# Run only from the installed root-owned path in a human-controlled local/SSH terminal.

set -euo pipefail

readonly TRUSTED_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH="$TRUSTED_PATH"

SERVICE_USER="nightdrop"
SERVICE_NAME="nightdrop.service"
SCRIPT_PATH="$(/usr/bin/readlink -f -- "${BASH_SOURCE[0]}")"
INSTALL_DIR="$(cd "$(/usr/bin/dirname -- "$SCRIPT_PATH")/.." && pwd -P)"
CONFIG_PATH="$INSTALL_DIR/config/config.yaml"

usage() {
  /usr/bin/cat <<USAGE
Usage: sudo $0 <gmail|outlook|zoho> [--profile NAME] [--port PORT] [--device-code]

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
  local current="$1" owner mode permissions parent
  while true; do
    read -r owner mode < <(/usr/bin/stat -Lc '%U %a' -- "$current") || return 1
    permissions=$((8#$mode))
    if [[ "$owner" != "root" ]] || (( (permissions & 8#022) != 0 )); then
      echo "Refusing non-root-owned or writable privileged path: $current" >&2
      return 1
    fi
    [[ "$current" == "/" ]] && break
    parent="$(/usr/bin/dirname -- "$current")" || return 1
    [[ "$parent" != "$current" ]] || return 1
    current="$parent"
  done
}

validate_trusted_path() {
  local directory canonical
  local -a directories=()
  IFS=':' read -r -a directories <<< "$TRUSTED_PATH"
  for directory in "${directories[@]}"; do
    [[ -d "$directory" ]] || continue
    canonical="$(/usr/bin/readlink -e -- "$directory")" || return 1
    [[ -d "$canonical" ]] || return 1
    assert_root_owned_path "$canonical" || {
      echo "Refusing untrusted executable path directory or ancestor: $directory" >&2
      return 1
    }
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
validate_trusted_path
assert_root_owned_path "$SCRIPT_PATH"
if ! ID_BIN="$(resolve_trusted_executable id)"; then
  echo "A trusted root-owned id executable is required on the fixed system PATH." >&2
  exit 1
fi
if ! "$ID_BIN" -- "$SERVICE_USER" >/dev/null 2>&1; then
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
if ! SYSTEMCTL_BIN="$(resolve_trusted_executable systemctl)"; then
  echo "A trusted root-owned systemctl executable is required on the fixed system PATH." >&2
  exit 1
fi
if ! SLEEP_BIN="$(resolve_trusted_executable sleep)"; then
  echo "A trusted root-owned sleep executable is required on the fixed system PATH." >&2
  exit 1
fi
if [[ ! -f "$INSTALL_DIR/dist/oauth-setup.js" || -L "$INSTALL_DIR/dist/oauth-setup.js" ]]; then
  echo "OAuth setup executable is missing or unsafe. Reinstall Nightdrop first." >&2
  exit 1
fi
assert_root_owned_path "$INSTALL_DIR/dist/oauth-setup.js"
if [[ ! -f "$CONFIG_PATH" || -L "$CONFIG_PATH" ]]; then
  echo "Nightdrop config is missing or unsafe: $CONFIG_PATH" >&2
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
  NIGHTDROP_PASS_BIN="$PASS_BIN" \
  "$NODE_BIN" "$INSTALL_DIR/dist/oauth-setup.js" "$@" --config "$CONFIG_PATH"

"$SYSTEMCTL_BIN" restart "$SERVICE_NAME"
healthy_checks=0
for _ in {1..10}; do
  "$SLEEP_BIN" 1
  if "$SYSTEMCTL_BIN" is-active --quiet "$SERVICE_NAME"; then
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
