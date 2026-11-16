#!/usr/bin/env bash
# scripts/rollback.sh
# Reverts to the previous image tag if deployment fails.

set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPTS_DIR}/.." && pwd)"

echo "Rolling back DuoStack deployment..."

cd "${PROJECT_DIR}"

if [ -f "${PROJECT_DIR}/.previous_tag" ]; then
  PREV_TAG=$(cat "${PROJECT_DIR}/.previous_tag")
  if [ -n "${PREV_TAG}" ]; then
    echo "Restoring previous image: ${PREV_TAG}"
    export TAG="${PREV_TAG}"
    docker compose up -d
    sleep 5
    "${SCRIPTS_DIR}/healthcheck.sh"
    echo "Rollback completed successfully."
    exit 0
  fi
fi

echo "Warning: No previous tag recorded. Restarting current docker compose..."
docker compose restart
exit 0
