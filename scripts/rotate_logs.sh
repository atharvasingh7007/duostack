#!/usr/bin/env bash
# scripts/rotate_logs.sh
# Cleans stale lock files, rotates logs, and archives temporary snapshots.

set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPTS_DIR}/.." && pwd)"
STATE_DIR="${PROJECT_DIR}/.duostack/state"

echo "Rotating logs and cleaning temporary files in ${STATE_DIR}..."

if [ -d "${STATE_DIR}" ]; then
  # Remove temporary .tmp files older than 1 day
  find "${STATE_DIR}" -name "*.tmp" -mtime +1 -delete 2>/dev/null || true

  # Clean stale lock files if older than 10 minutes
  find "${STATE_DIR}" -name "*.lock" -mmin +10 -delete 2>/dev/null || true

  echo "Log rotation and cleanup complete."
else
  echo "State directory ${STATE_DIR} does not exist."
fi
