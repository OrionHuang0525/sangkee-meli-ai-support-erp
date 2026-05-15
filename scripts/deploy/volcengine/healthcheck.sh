#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/meli-ai-support}"
DEPLOY_ENV="${DEPLOY_ENV:-.env.deploy}"

if [[ -f "$APP_DIR/$DEPLOY_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$APP_DIR/$DEPLOY_ENV"
  set +a
fi

API_HEALTH_URL="${API_HEALTH_URL:-http://${API_BIND:-127.0.0.1}:${API_PORT:-3001}/readyz}"
ATTEMPTS="${HEALTHCHECK_ATTEMPTS:-30}"
SLEEP_SECONDS="${HEALTHCHECK_SLEEP_SECONDS:-3}"

for attempt in $(seq 1 "$ATTEMPTS"); do
  if curl -fsS "$API_HEALTH_URL" >/tmp/meli-ai-support-readyz.json; then
    echo "readyz ok: $API_HEALTH_URL"
    cat /tmp/meli-ai-support-readyz.json
    echo
    exit 0
  fi
  echo "readyz pending ($attempt/$ATTEMPTS): $API_HEALTH_URL"
  sleep "$SLEEP_SECONDS"
done

echo "readyz failed after $ATTEMPTS attempts: $API_HEALTH_URL" >&2
exit 1
