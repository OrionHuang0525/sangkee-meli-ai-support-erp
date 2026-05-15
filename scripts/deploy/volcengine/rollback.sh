#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <image-tag-to-rollback>" >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/meli-ai-support}"
IMAGE_TAG="$1"
export IMAGE_TAG

"$APP_DIR/scripts/deploy/volcengine/deploy.sh" "$IMAGE_TAG"
