#!/usr/bin/env bash
# scripts/healthcheck.sh
# Verifies that DuoStack API and orchestrator are healthy and responsive.

set -euo pipefail

PORT="${PORT:-3747}"
HOST="${HOST:-127.0.0.1}"
HEALTH_URL="http://${HOST}:${PORT}/health"
MAX_ATTEMPTS=5
SLEEP_SECS=3

echo "Checking DuoStack health at ${HEALTH_URL}..."

for i in $(seq 1 $MAX_ATTEMPTS); do
  HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" --max-time 5 "${HEALTH_URL}" || true)
  HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')
  HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -n1)

  if [ "$HTTP_CODE" = "200" ]; then
    echo "DuoStack is healthy! Response: ${HTTP_BODY}"
    exit 0
  else
    echo "Attempt $i/$MAX_ATTEMPTS: status code $HTTP_CODE. Retrying in ${SLEEP_SECS}s..."
    sleep $SLEEP_SECS
  fi
done

echo "Error: DuoStack health check failed after $MAX_ATTEMPTS attempts."
exit 1
