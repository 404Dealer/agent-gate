#!/usr/bin/env bash
# draft-email.sh — Helper script to drop an email draft into agent-gate's inbox
# Usage: ./draft-email.sh <to> <subject> <body_html> [provider] [context] [source]
#
# Requires: membership in agentgate-inbox group, agent-gate running

set -euo pipefail

TO="${1:?Usage: draft-email.sh <to> <subject> <body_html> [provider] [context] [source]}"
SUBJECT="${2:?Missing subject}"
BODY="${3:?Missing body (HTML)}"
PROVIDER="${4:-zoho}"
CONTEXT="${5:-Drafted by agent}"
SOURCE="${6:-agent}"

DRAFT_ID=$(cat /proc/sys/kernel/random/uuid)
DRAFT_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
FILENAME="draft-$(date +%Y%m%d-%H%M%S)-${DRAFT_ID:0:8}.json"

# Escape JSON strings
json_escape() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()), end="")'
}

TO_ESC=$(json_escape "$TO")
SUBJECT_ESC=$(json_escape "$SUBJECT")
BODY_ESC=$(json_escape "$BODY")
CONTEXT_ESC=$(json_escape "$CONTEXT")
SOURCE_ESC=$(json_escape "$SOURCE")

DRAFT_JSON=$(cat <<EOF
{
  "id": "$DRAFT_ID",
  "type": "email",
  "status": "pending",
  "createdAt": "$DRAFT_TS",
  "updatedAt": "$DRAFT_TS",
  "source": $SOURCE_ESC,
  "provider": "$PROVIDER",
  "payload": {
    "from": "noreply@placeholder.com",
    "to": $TO_ESC,
    "subject": $SUBJECT_ESC,
    "body": $BODY_ESC,
    "cc": [],
    "bcc": [],
    "replyTo": ""
  },
  "metadata": {
    "context": $CONTEXT_ESC,
    "priority": "normal",
    "tags": []
  }
}
EOF
)

sg agentgate-inbox -c "cat > /opt/agent-gate/drafts/inbox/$FILENAME << 'AGENTGATE_DRAFT'
$DRAFT_JSON
AGENTGATE_DRAFT"

echo "Draft submitted: $FILENAME"
echo "Waiting for approval in Telegram."
