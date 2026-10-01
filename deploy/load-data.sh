#!/usr/bin/env bash
# Copies the polities/geometries from the local dev database to the server (replacing what is there).
# Import and clipping happen locally (osm2pgsql does not belong on a 2 GB server).
source "$(dirname "$0")/lib.sh"

DUMP=deploy/hm.dump
if [ "${SKIP_DUMP:-0}" != "1" ] || [ ! -s "$DUMP" ]; then
  echo "==> dumping the local database"
  docker compose exec -T db pg_dump -U postgres -d historicalmap -Fc --data-only \
    -t polities -t polity_geometries > "$DUMP"
fi
ls -lh "$DUMP"

echo "==> uploading"
remote "mkdir -p '$DEPLOY_DIR/dump'"
if command -v rsync >/dev/null && remote 'command -v rsync' >/dev/null 2>&1; then
  # resumable: an interrupted 1 GB upload continues instead of starting over
  rsync -e "ssh ${SSH_OPTS[*]}" --partial --inplace --progress "$DUMP" "$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_DIR/dump/hm.dump"
else
  scp "${SSH_OPTS[@]}" "$DUMP" "$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_DIR/dump/hm.dump"
fi

echo "==> restoring"
# NOTE: every `docker compose exec -T` below reads stdin; without </dev/null it would swallow the rest of
# this script (it is fed to `bash -s` on stdin) and everything after it would silently not run.
remote bash -s <<REMOTE
set -euo pipefail
cd '$DEPLOY_DIR'
docker compose up -d db
until docker compose exec -T db pg_isready -U postgres -d historicalmap -h 127.0.0.1 </dev/null >/dev/null 2>&1; do sleep 2; done
docker compose exec -T db psql -U postgres -d historicalmap -c 'TRUNCATE polity_geometries, polities RESTART IDENTITY CASCADE' </dev/null
docker compose exec -T db pg_restore -U postgres -d historicalmap --data-only --no-owner /dump/hm.dump </dev/null
docker compose exec -T db psql -U postgres -d historicalmap \
  -c "SELECT setval(pg_get_serial_sequence('polities','id'), COALESCE(max(id), 1)) FROM polities" \
  -c 'ANALYZE' </dev/null
rows=\$(docker compose exec -T db psql -U postgres -d historicalmap -At -c 'SELECT count(*) FROM polity_geometries' </dev/null)
echo "polity_geometries rows on the server: \$rows"
[ "\$rows" -gt 0 ] || { echo "restore produced no rows" >&2; exit 1; }
# new data: restart Martin and drop the tile cache (it lives in the web container)
docker compose restart martin
docker compose up -d --force-recreate web
REMOTE
[ "${KEEP_DUMP:-0}" = "1" ] || rm -f "$DUMP"
echo "==> data loaded"
