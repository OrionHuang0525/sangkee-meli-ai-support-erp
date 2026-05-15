#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/meli-ai-support}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DEPLOY_ENV="${DEPLOY_ENV:-.env.deploy}"
SERVICE="${1:-api}"
TAIL="${TAIL:-200}"

cd "$APP_DIR"
docker compose --env-file "$DEPLOY_ENV" -f "$COMPOSE_FILE" logs --tail "$TAIL" -f "$SERVICE"
