#!/usr/bin/env bash
set -euo pipefail

readonly TRUSTED_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH="$TRUSTED_PATH"
export LC_ALL=C

SERVICE_USER="nightdrop"
PROVIDER="${1:-}"
SCRIPT_PATH="$(/usr/bin/readlink -f -- "${BASH_SOURCE[0]}")"

usage() {
  /usr/bin/cat <<'EOF'
Usage: sudo /opt/nightdrop/scripts/configure-provider-secrets.sh <provider>

Providers:
  telegram Store Nightdrop approval bot token
  gmail    Store Gmail OAuth send credentials for email-gmail
  outlook  Store Microsoft Graph OAuth send credentials for email-outlook
  zoho     Store Zoho OAuth send credentials for email-zoho

Run this from a human-controlled terminal or SSH session, not from a Hermes
conversation, if your goal is to keep send credentials out of Hermes.

Secrets are stored in the Nightdrop service account's pass store under nightdrop/*.
EOF
}

assert_root_owned_path() {
  local current="$1" owner mode permissions
  while [[ "$current" != "/" ]]; do
    read -r owner mode < <(/usr/bin/stat -Lc '%U %a' -- "$current") || return 1
    permissions=$((8#$mode))
    if [[ "$owner" != "root" ]] || (( (permissions & 8#022) != 0 )); then
      echo "Refusing non-root-owned or writable privileged path: $current" >&2
      return 1
    fi
    current="$(/usr/bin/dirname -- "$current")" || return 1
  done
}

validate_trusted_path() {
  local directory owner mode permissions
  local -a directories=()
  IFS=':' read -r -a directories <<< "$TRUSTED_PATH"
  for directory in "${directories[@]}"; do
    [[ -d "$directory" ]] || continue
    read -r owner mode < <(/usr/bin/stat -Lc '%U %a' -- "$directory") || return 1
    permissions=$((8#$mode))
    if [[ "$owner" != "root" ]] || (( (permissions & 8#022) != 0 )); then
      echo "Refusing untrusted executable path directory: $directory" >&2
      return 1
    fi
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

if [[ "$PROVIDER" == "-h" || "$PROVIDER" == "--help" || -z "$PROVIDER" ]]; then
  usage
  exit 0
fi
if [[ $# -ne 1 ]]; then
  echo "Exactly one provider argument is required; credentials are never accepted on argv." >&2
  usage >&2
  exit 2
fi
if [[ $EUID -ne 0 ]]; then
  echo "Run as root via sudo so secrets can be stored as $SERVICE_USER." >&2
  exit 1
fi
if [[ ! -t 0 || ! -t 1 ]]; then
  echo "Refusing non-interactive secret setup; a human TTY is required." >&2
  exit 1
fi
validate_trusted_path
assert_root_owned_path "$SCRIPT_PATH"
if ! ID_BIN="$(resolve_trusted_executable id)"; then
  echo "A trusted root-owned id executable is required on the fixed system PATH." >&2
  exit 1
fi
if ! "$ID_BIN" -- "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Service user '$SERVICE_USER' does not exist. Run the production installer first." >&2
  exit 1
fi
if ! PASS_BIN="$(resolve_trusted_executable pass)"; then
  echo "A trusted root-owned pass executable is required on the fixed system PATH." >&2
  exit 1
fi
if ! TIMEOUT_BIN="$(resolve_trusted_executable timeout)"; then
  echo "A trusted root-owned timeout executable is required on the fixed system PATH." >&2
  exit 1
fi
if ! RUNUSER_BIN="$(resolve_trusted_executable runuser)"; then
  echo "A trusted root-owned runuser executable is required on the fixed system PATH." >&2
  exit 1
fi
if ! ENV_BIN="$(resolve_trusted_executable env)"; then
  echo "A trusted root-owned env executable is required on the fixed system PATH." >&2
  exit 1
fi

store_secret() {
  local key="$1"
  local prompt="$2"
  local value=""

  while [[ -z "$value" ]]; do
    read -rsp "$prompt: " value
    printf '\n'
    if [[ -z "$value" ]]; then
      echo "Value cannot be empty. Try again." >&2
    elif [[ "$value" == *[![:graph:]]* ]]; then
      echo "Value must contain printable non-space ASCII characters only. Try again." >&2
      value=""
    fi
  done

  printf '%s\n' "$value" | "$TIMEOUT_BIN" --kill-after=5s 30s "$RUNUSER_BIN" -u "$SERVICE_USER" -- "$ENV_BIN" -i \
    HOME="/home/$SERVICE_USER" \
    PATH="$TRUSTED_PATH" \
    PASSWORD_STORE_DIR="/home/$SERVICE_USER/.password-store" \
    GNUPGHOME="/home/$SERVICE_USER/.gnupg" \
    "$PASS_BIN" insert --force --multiline "nightdrop/$key" >/dev/null

  unset value
  echo "Stored nightdrop/$key"
}

confirm_boundary() {
  /usr/bin/cat <<'EOF'

Security reminder:
- Do not paste these credentials into Hermes.
- Do not run this helper through a Hermes-controlled terminal if you require a hard boundary.
- These credentials should be readable only by the Nightdrop service account.

EOF
  read -rp "Continue? [y/N] " answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
}

confirm_boundary

case "$PROVIDER" in
  telegram)
    echo "Storing Nightdrop approval Telegram bot token. Use a bot dedicated to Nightdrop, not the Hermes bot."
    store_secret "telegram-bot-token" "Telegram bot token for Nightdrop approvals"
    ;;
  gmail)
    echo "Storing Gmail Desktop/public-client credentials. Required scopes: openid email https://www.googleapis.com/auth/gmail.send"
    store_secret "google-client-id" "Google OAuth client ID"
    store_secret "google-refresh-token" "Google OAuth refresh token with gmail.send scope"
    ;;
  outlook)
    echo "Storing Outlook public-client credentials. Required delegated scopes: offline_access Mail.Send User.Read"
    store_secret "microsoft-client-id" "Microsoft Entra application/client ID"
    store_secret "microsoft-refresh-token" "Microsoft OAuth refresh token"
    ;;
  zoho)
    echo "Storing Zoho OAuth send credentials."
    store_secret "zoho-client-id" "Zoho OAuth client ID"
    store_secret "zoho-client-secret" "Zoho OAuth client secret"
    store_secret "zoho-refresh-token" "Zoho OAuth refresh token"
    ;;
  *)
    echo "Unknown provider: $PROVIDER" >&2
    usage >&2
    exit 2
    ;;
esac

/usr/bin/cat <<EOF

Done. Stored $PROVIDER credentials under the $SERVICE_USER pass store.

Verify references without printing secret values:
  sudo -u $SERVICE_USER env HOME=/home/$SERVICE_USER GNUPGHOME=/home/$SERVICE_USER/.gnupg PASSWORD_STORE_DIR=/home/$SERVICE_USER/.password-store pass ls nightdrop

Then restart Nightdrop:
  sudo systemctl restart nightdrop
  sudo systemctl status nightdrop --no-pager
EOF
