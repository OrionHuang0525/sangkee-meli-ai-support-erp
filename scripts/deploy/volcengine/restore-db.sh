#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <backup.dump.gz|backup.dump>" >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/meli-ai-support}"
ENV_FILE="${ENV_FILE:-.env.prod}"
BACKUP_FILE="$1"

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

TMP_FILE="$BACKUP_FILE"
if [[ "$BACKUP_FILE" == *.gz ]]; then
  TMP_FILE="$(mktemp /tmp/meli-ai-support-restore.XXXXXX.dump)"
  gzip -dc "$BACKUP_FILE" > "$TMP_FILE"
fi

pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" "$TMP_FILE"

if [[ "$TMP_FILE" != "$BACKUP_FILE" ]]; then
  rm -f "$TMP_FILE"
fi
