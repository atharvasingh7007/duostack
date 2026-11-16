#!/usr/bin/env bash
# scripts/backup.sh
# Archives DuoStack append-only event log and decisions markdown.

set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPTS_DIR}/.." && pwd)"
BACKUP_DIR="${PROJECT_DIR}/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
ARCHIVE_NAME="duostack_backup_${TIMESTAMP}.tar.gz"

mkdir -p "${BACKUP_DIR}"

echo "Creating backup in ${BACKUP_DIR}/${ARCHIVE_NAME}..."

# Archive .duostack/state/events.jsonl and .duostack/decisions.md
if [ -d "${PROJECT_DIR}/.duostack" ]; then
  tar -czf "${BACKUP_DIR}/${ARCHIVE_NAME}" \
    -C "${PROJECT_DIR}" \
    .duostack/state/events.jsonl \
    .duostack/decisions.md \
    2>/dev/null || tar -czf "${BACKUP_DIR}/${ARCHIVE_NAME}" -C "${PROJECT_DIR}" .duostack/
  
  echo "Backup created successfully: ${ARCHIVE_NAME}"
  
  # Prune backups older than 30 days (keep disk clean)
  find "${BACKUP_DIR}" -name "duostack_backup_*.tar.gz" -mtime +30 -delete 2>/dev/null || true
else
  echo "No .duostack directory found to back up."
fi
