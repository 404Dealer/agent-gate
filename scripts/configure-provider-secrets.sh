#!/usr/bin/env bash
set -euo pipefail

SERVICE_USER="agentgate"
PROVIDER="${1:-}"

usage() {
  cat <<'EOF'
Usage: sudo scripts/configure-provider-secrets.sh <provider>

Providers:
  telegram Store agent-gate approval bot token
  gmail    Store Gmail OAuth send credentials for email-gmail
  zoho     Store Zoho OAuth send credentials for email-zoho

Run this from a human-controlled terminal or SSH session, not from a Hermes
conversation, if your goal is to keep send credentials out of Hermes.

Secrets are stored in the agentgate user's pass store under agent-gate/*.
EOF
}

if [[ "${PROVIDER:-}" == "-h" || "${PROVIDER:-}" == "--help" || -z "${PROVIDER:-}" ]]; then
  usage
  exit 0
fi

if [[ $EUID -ne 0 ]]; then
  echo "Run as root via sudo so secrets can be stored as $SERVICE_USER." >&2
  exit 1
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Service user '$SERVICE_USER' does not exist. Run scripts/install-production.sh first." >&2
  exit 1
fi

if ! command -v pass >/dev/null 2>&1; then
  echo "pass is required. Install it and initialize the $SERVICE_USER password store first." >&2
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
    fi
  done

  printf '%s\n' "$value" | sudo -u "$SERVICE_USER" \
    PASSWORD_STORE_DIR="/home/$SERVICE_USER/.password-store" \
    GNUPGHOME="/home/$SERVICE_USER/.gnupg" \
    pass insert -m "agent-gate/$key" >/dev/null

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
    echo "Storing Gmail OAuth send credentials. Required scope: https://www.googleapis.com/auth/gmail.send"
    store_secret "google-client-id" "Google OAuth client ID"
    store_secret "google-client-secret" "Google OAuth client secret"
    store_secret "google-refresh-token" "Google OAuth refresh token with gmail.send scope"
    ;;
  zoho)
    echo "Storing Zoho OAuth send credentials."
    store_secret "zoho-client-id" "Zoho OAuth client ID"
    store_secret "zoho-client-secret" "Zoho OAuth client secret"
    store_secret "zoho-refresh-token" "Zoho OAuth refresh token"
    store_secret "zoho-account-id" "Zoho account ID"
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
  sudo -u $SERVICE_USER PASSWORD_STORE_DIR=/home/$SERVICE_USER/.password-store pass ls agent-gate

Then restart agent-gate:
  sudo systemctl restart agent-gate
  sudo systemctl status agent-gate --no-pager
EOF
