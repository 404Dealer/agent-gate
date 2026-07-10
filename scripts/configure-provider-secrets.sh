#!/usr/bin/env bash
set -euo pipefail

readonly TRUSTED_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH="$TRUSTED_PATH"
export LC_ALL=C

SERVICE_USER="agentgate"
PROVIDER="${1:-}"
SCRIPT_PATH="$(/usr/bin/readlink -f -- "${BASH_SOURCE[0]}")"

usage() {
  cat <<'EOF'
Usage: sudo /opt/agent-gate/scripts/configure-provider-secrets.sh <provider>

Providers:
  telegram Store agent-gate approval bot token
  gmail    Store Gmail OAuth send credentials for email-gmail
  outlook  Store Microsoft Graph OAuth send credentials for email-outlook
  zoho     Store Zoho OAuth send credentials for email-zoho

Run this from a human-controlled terminal or SSH session, not from a Hermes
conversation, if your goal is to keep send credentials out of Hermes.

Secrets are stored in the agentgate user's pass store under agent-gate/*.
EOF
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
assert_root_owned_path "$SCRIPT_PATH"
if ! id -- "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Service user '$SERVICE_USER' does not exist. Run the production installer first." >&2
  exit 1
fi
if ! PASS_BIN="$(resolve_trusted_executable pass)"; then
  echo "A trusted root-owned pass executable is required on the fixed system PATH." >&2
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

  printf '%s\n' "$value" | timeout --kill-after=5s 30s runuser -u "$SERVICE_USER" -- env -i \
    HOME="/home/$SERVICE_USER" \
    PATH="$TRUSTED_PATH" \
    PASSWORD_STORE_DIR="/home/$SERVICE_USER/.password-store" \
    GNUPGHOME="/home/$SERVICE_USER/.gnupg" \
    "$PASS_BIN" insert --force --multiline "agent-gate/$key" >/dev/null

  unset value
  echo "Stored agent-gate/$key"
}

confirm_boundary() {
  cat <<'EOF'

Security reminder:
- Do not paste these credentials into Hermes.
- Do not run this helper through a Hermes-controlled terminal if you require a hard boundary.
- These credentials should be readable only by the agentgate service user.

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
    echo "Storing agent-gate approval Telegram bot token. Use a bot dedicated to agent-gate, not the Hermes bot."
    store_secret "telegram-bot-token" "Telegram bot token for agent-gate approvals"
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

cat <<EOF

Done. Stored $PROVIDER credentials under the $SERVICE_USER pass store.

Verify references without printing secret values:
  sudo -u $SERVICE_USER env HOME=/home/$SERVICE_USER GNUPGHOME=/home/$SERVICE_USER/.gnupg PASSWORD_STORE_DIR=/home/$SERVICE_USER/.password-store pass ls agent-gate

Then restart agent-gate:
  sudo systemctl restart agent-gate
  sudo systemctl status agent-gate --no-pager
EOF
