#!/usr/bin/env bash
set -Eeuo pipefail

WEBHOOK_URL="${FEISHU_DEPLOY_WEBHOOK:-}"
MESSAGE="${1:-Meli AI Support deployment event}"

if [[ -z "$WEBHOOK_URL" ]]; then
  exit 0
fi

ESCAPED_MESSAGE="${MESSAGE//\\/\\\\}"
ESCAPED_MESSAGE="${ESCAPED_MESSAGE//\"/\\\"}"
ESCAPED_MESSAGE="${ESCAPED_MESSAGE//$'\n'/\\n}"

curl -fsS "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"$ESCAPED_MESSAGE\"}}" \
  >/dev/null
