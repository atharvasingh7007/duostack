#!/usr/bin/env bash
# scripts/deploy.sh
# Zero-downtime deployment script with automated rollback on health failure.

set -euo pipefail

TAG="${1:-latest}"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPTS_DIR}/.." && pwd)"

echo "Starting deployment for DuoStack tag: ${TAG}"
cd "${PROJECT_DIR}"

# 1. Run backup before deployment
echo "Step 1: Running pre-deployment state backup..."
"${SCRIPTS_DIR}/backup.sh"

# 2. Save current tag for potential rollback
CURRENT_TAG=$(docker inspect --format='{{.Config.Image}}' duostack-engine 2>/dev/null || echo "")
echo "${CURRENT_TAG}" > "${PROJECT_DIR}/.previous_tag"

# 3. Pull/Build new image and restart container
echo "Step 2: Deploying new container image..."
export TAG="${TAG}"
docker compose pull || true
docker compose up -d --remove-orphans

# 4. Wait for container startup and run health check
echo "Step 3: Running post-deployment health check..."
sleep 5

if "${SCRIPTS_DIR}/healthcheck.sh"; then
  echo "Deployment successful: DuoStack is running image tag ${TAG}."
  exit 0
else
  echo "Health check failed! Initiating automated rollback..."
  "${SCRIPTS_DIR}/rollback.sh"
  exit 1
fi
