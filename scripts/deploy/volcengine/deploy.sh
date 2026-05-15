#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/meli-ai-support}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DEPLOY_ENV="${DEPLOY_ENV:-.env.deploy}"
IMAGE_TAG="${1:-${IMAGE_TAG:-main-latest}}"

cd "$APP_DIR"

if [[ ! -f "$DEPLOY_ENV" ]]; then
  echo "Missing $APP_DIR/$DEPLOY_ENV" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$DEPLOY_ENV"
set +a
export IMAGE_TAG

notify() {
  if [[ -x "$APP_DIR/scripts/deploy/volcengine/notify-feishu.sh" ]]; then
    "$APP_DIR/scripts/deploy/volcengine/notify-feishu.sh" "$1" || true
  fi
}

trap 'notify "Meli AI Support deploy failed on $(hostname): tag=${IMAGE_TAG}"' ERR

echo "Deploying Meli AI Support tag=${IMAGE_TAG}"
docker compose --env-file "$DEPLOY_ENV" -f "$COMPOSE_FILE" pull migrate api worker web
docker compose --env-file "$DEPLOY_ENV" -f "$COMPOSE_FILE" run --rm migrate
docker compose --env-file "$DEPLOY_ENV" -f "$COMPOSE_FILE" up -d api worker web

"$APP_DIR/scripts/deploy/volcengine/healthcheck.sh"
notify "Meli AI Support deploy succeeded on $(hostname): tag=${IMAGE_TAG}"
