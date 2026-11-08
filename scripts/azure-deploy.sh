#!/usr/bin/env bash
# Create or update the audit-logs Container App: scale-to-zero (min 0) because the
# API is event-driven. Secrets come from the environment and are never echoed.
# Required: IMAGE, GHCR_USERNAME, GHCR_PULL_TOKEN, DATABASE_URL (audit_runtime),
# DATABASE_URL_MIGRATIONS (owner), DATABASE_URL_ANONYMIZE (audit_anonymize).
# Optional: RATE_LIMIT_PER_SECOND (default 100).
set -euo pipefail

RG="${AZURE_RESOURCE_GROUP:-rg-brenraphaels}"
ENV_NAME="${AZURE_CONTAINERAPPS_ENV:-cae-brenraphaels}"
APP="${AZURE_APP_NAME:-audit-logs}"
RATE_LIMIT_PER_SECOND="${RATE_LIMIT_PER_SECOND:-100}"
export RATE_LIMIT_PER_SECOND

for v in IMAGE GHCR_USERNAME GHCR_PULL_TOKEN DATABASE_URL DATABASE_URL_MIGRATIONS DATABASE_URL_ANONYMIZE; do
  [ -n "${!v:-}" ] || { echo "Missing required value: $v" >&2; exit 1; }
done

SECRETS=(
  "database-url=$DATABASE_URL" "database-url-migrations=$DATABASE_URL_MIGRATIONS"
  "database-url-anonymize=$DATABASE_URL_ANONYMIZE" "ghcr-pull-token=$GHCR_PULL_TOKEN"
)

if az containerapp show -n "$APP" -g "$RG" >/dev/null 2>&1; then
  az containerapp secret set -n "$APP" -g "$RG" --secrets "${SECRETS[@]}" >/dev/null
  az containerapp registry set -n "$APP" -g "$RG" --server ghcr.io \
    --username "$GHCR_USERNAME" --password "$GHCR_PULL_TOKEN" >/dev/null
  az containerapp update -n "$APP" -g "$RG" --image "$IMAGE" \
    --min-replicas 0 --max-replicas 2 --cpu 0.25 --memory 0.5Gi >/dev/null
else
  az containerapp create -n "$APP" -g "$RG" --environment "$ENV_NAME" --image "$IMAGE" \
    --registry-server ghcr.io --registry-username "$GHCR_USERNAME" \
    --registry-password "$GHCR_PULL_TOKEN" \
    --ingress external --target-port 8080 --transport auto \
    --min-replicas 0 --max-replicas 2 --cpu 0.25 --memory 0.5Gi \
    --secrets "${SECRETS[@]}" >/dev/null
fi

# Env vars and health probes need YAML. The exported template holds only secretref names.
YAML=$(mktemp)
trap 'rm -f "$YAML"' EXIT
az containerapp show -n "$APP" -g "$RG" -o json > "$YAML"
python3 - "$YAML" <<'PY'
import json, os, sys
path = sys.argv[1]
app = json.load(open(path))
plain = {"PORT": "8080", "RATE_LIMIT_PER_SECOND": os.environ["RATE_LIMIT_PER_SECOND"]}
refs = {"DATABASE_URL": "database-url", "DATABASE_URL_MIGRATIONS": "database-url-migrations",
        "DATABASE_URL_ANONYMIZE": "database-url-anonymize"}
container = app["properties"]["template"]["containers"][0]
container["env"] = ([{"name": k, "value": v} for k, v in plain.items()]
                    + [{"name": k, "secretRef": v} for k, v in refs.items()])
def probe(kind, **kw):
    return {"type": kind, "httpGet": {"path": "/health", "port": 8080, "scheme": "HTTP"},
            "timeoutSeconds": 5, **kw}
container["probes"] = [
    probe("Startup", periodSeconds=3, failureThreshold=20, initialDelaySeconds=1),
    probe("Liveness", periodSeconds=30, failureThreshold=3, initialDelaySeconds=10),
    probe("Readiness", periodSeconds=10, failureThreshold=3, initialDelaySeconds=2),
]
json.dump(app, open(path, "w"))
PY
az containerapp update -n "$APP" -g "$RG" --yaml "$YAML" >/dev/null

FQDN=$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)
echo "Deployed https://$FQDN"
echo "fqdn=$FQDN" >> "${GITHUB_OUTPUT:-/dev/null}"
