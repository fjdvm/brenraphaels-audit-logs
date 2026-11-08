#!/usr/bin/env bash
# Starts the built image against the disposable CI database, then checks health,
# an authenticated write and an authenticated read. Expects IMAGE and a migrated
# Postgres reachable as OWNER_URL (owner) from the host.
set -euo pipefail
: "${IMAGE:?}" "${OWNER_URL:?}"
PORT="${SMOKE_PORT:-18090}"
RUNTIME_URL="${RUNTIME_URL_FOR_CONTAINER:?}"
export DATABASE_URL_MIGRATIONS="$OWNER_URL"
WRITE_KEY=$(node scripts/key.ts create write:Authentication)
ADMIN_KEY=$(node scripts/key.ts create read:admin)
docker rm -f audit-logs-smoke >/dev/null 2>&1 || true
docker run -d --name audit-logs-smoke --network host -e PORT="$PORT" \
  -e DATABASE_URL="$RUNTIME_URL" -e DATABASE_URL_MIGRATIONS="$OWNER_URL" \
  -e DATABASE_URL_ANONYMIZE="$OWNER_URL" -e RATE_LIMIT_PER_SECOND=100 "$IMAGE" >/dev/null
trap 'docker logs audit-logs-smoke || true; docker rm -f audit-logs-smoke >/dev/null' EXIT
for attempt in $(seq 1 30); do
  curl --fail --silent "http://127.0.0.1:$PORT/health" && break
  [ "$attempt" = 30 ] && { echo "health never became ready" >&2; exit 1; }
  sleep 1
done
echo
BASE_URL="http://127.0.0.1:$PORT" WRITE_KEY="$WRITE_KEY" ADMIN_KEY="$ADMIN_KEY" node scripts/smoke.ts
