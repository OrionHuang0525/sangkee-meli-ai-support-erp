#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/meli-ai-support}"
ENV_FILE="${ENV_FILE:-.env.prod}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"

cd "$APP_DIR"

read_env_value() {
  local key="$1"
  local file="$2"
  grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2-
}

if [[ -z "${DATABASE_URL:-}" && -f "$ENV_FILE" ]]; then
  DATABASE_URL="$(read_env_value DATABASE_URL "$ENV_FILE")"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
OUTPUT="$BACKUP_DIR/meli-ai-support-$(date +%Y%m%d-%H%M%S).dump"
pg_dump "$DATABASE_URL" --format=custom --file "$OUTPUT"
gzip -f "$OUTPUT"
echo "$OUTPUT.gz"
