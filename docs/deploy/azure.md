# Deploying to Azure Container Apps

audit-logs runs as an Azure Container App on the Consumption plan: it scales to zero when idle,
and every push to `main` builds the `Dockerfile` and rolls out a new revision
(`.github/workflows/deploy-azure.yml`). The database stays on Neon; nothing about the data moves.

The commands below use the Azure CLI (`az`). Run `az login` first. Names in `<angle brackets>` are yours to choose;
the rest can be copied as is.

## 1. Shared setup (once for all services)

Skip this section if file-storage or auth already created these.

```sh
RG=brenraphaels-rg
LOCATION=southeastasia            # Singapore, next to Vercel's sin1 and Neon
ENV=brenraphaels-env
ACR=<globally-unique-lowercase-name>   # e.g. brenraphaelsacr

az provider register -n Microsoft.App --wait
az provider register -n Microsoft.OperationalInsights --wait

az group create -n $RG -l $LOCATION
az acr create -g $RG -n $ACR --sku Basic --admin-enabled true
az containerapp env create -g $RG -n $ENV -l $LOCATION
```

Create the identity GitHub Actions deploys with. Copy the whole JSON it prints.

```sh
SUB=$(az account show --query id -o tsv)
az ad sp create-for-rbac --name gh-brenraphaels-deploy --role contributor \
  --scopes /subscriptions/$SUB/resourceGroups/$RG --json-auth
```

Then in the Azure portal, open **Cost Management → Budgets** and add a budget with alerts at 50%, 75% and 90%,
so the student credit cannot run out unnoticed.

## 2. Create the container app

Use the same values as the Vercel project's production environment variables.

```sh
az containerapp create -g $RG -n audit-logs --environment $ENV \
  --image mcr.microsoft.com/k8se/quickstart:latest \
  --ingress external --target-port 3000 \
  --min-replicas 0 --max-replicas 2 --cpu 0.25 --memory 0.5Gi \
  --secrets database-url='<DATABASE_URL>' \
  --env-vars DATABASE_URL=secretref:database-url PORT=3000
```

Add any other variable the Vercel project sets (for example `RATE_LIMIT_PER_SECOND`) the same way:
plain values with `--env-vars NAME=value`, secrets with `--secrets` and `secretref:`. To change them later, use
`az containerapp secret set` and `az containerapp update --set-env-vars`.

The placeholder image does not listen on port 3000, so the app reports unhealthy until the first deploy.

## 3. Connect GitHub Actions

In the GitHub repository, **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `AZURE_CREDENTIALS` | the JSON from `az ad sp create-for-rbac` |
| Variable | `AZURE_RESOURCE_GROUP` | `brenraphaels-rg` |
| Variable | `AZURE_ACR_NAME` | your `$ACR` |
| Variable | `AZURE_CONTAINER_APP` | `audit-logs` |

Run the **Deploy to Azure Container Apps** workflow once from the Actions tab (or push to `main`).

## 4. Check it and switch callers over

```sh
URL=https://$(az containerapp show -g $RG -n audit-logs --query properties.configuration.ingress.fqdn -o tsv)
curl $URL/health      # {"status":"ok"}
```

Then point every caller at `$URL` instead of the old `*.vercel.app` address:

- the API gateway (brenraphaels-proxy), which routes `/audit` here
- any app or service configured with the audit-logs URL directly

Once traffic has moved, remove or disconnect the Vercel project so it stops deploying.

## Costs

- The app scales to zero and draws on the Consumption plan's monthly free grant first
  (180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests per subscription).
- Azure Container Registry Basic is billed per day (about USD 5 a month), shared by all services.
- The environment's Log Analytics workspace bills for log ingestion beyond its free allowance.
