#!/usr/bin/env bash
# Prepares the isolated e2e stack: database historicalmap_e2e with the test fixtures (HB + OHM),
# plus its own API (:3002) and Martin (:3101). The dev database is never touched.
set -euo pipefail
cd "$(dirname "$0")/.."
E2E_URL=postgres://postgres:postgres@localhost:5433/historicalmap_e2e

docker compose up -d --wait db
docker compose exec -T db psql -U postgres -q -c "DROP DATABASE IF EXISTS historicalmap_e2e WITH (FORCE)" -c "CREATE DATABASE historicalmap_e2e"
DATABASE_URL=$E2E_URL DATA_DIR=db/fixtures npx tsx scripts/import.ts
docker compose exec -T db psql -U postgres -d historicalmap_e2e -q < db/fixtures/ohm/staging.sql
DATABASE_URL=$E2E_URL OHM_SKIP_LOAD=1 npx tsx scripts/import-ohm.ts
# Martin must start after the SQL functions exist (the imports above apply the schema)
docker compose --profile e2e up -d --build --wait --force-recreate api-e2e martin-e2e
