#!/usr/bin/env bash
# Builds the web and api images for linux/amd64, ships them over SSH (no registry, no tokens) and
# (re)starts the stack on the server. The database password is generated on the server, once.
# Load the data separately with deploy/load-data.sh.
source "$(dirname "$0")/lib.sh"

TAG="$(git rev-parse --short HEAD)"
git diff --quiet HEAD || TAG="$TAG-dirty"
echo "Deploying $TAG to $DEPLOY_HOST:$DEPLOY_DIR"

echo "==> building the site"
VITE_API_URL=/api VITE_TILES_URL=/tiles npm run build -w apps/web

echo "==> building images (linux/amd64)"
docker build --platform linux/amd64 -f apps/web/Dockerfile -t "historicalmap-web:$TAG" .
docker build --platform linux/amd64 -f apps/api/Dockerfile -t "historicalmap-api:$TAG" .

echo "==> smoke-testing the web image"
deploy/smoke-web.sh "historicalmap-web:$TAG"

echo "==> shipping images"
for name in web api; do
  docker save "historicalmap-$name:$TAG" | gzip | remote "gunzip | docker load"
done

echo "==> syncing the stack definition"
remote "mkdir -p '$DEPLOY_DIR/db' '$DEPLOY_DIR/dump'"
scp "${SSH_OPTS[@]}" deploy/docker-compose.prod.yml "$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_DIR/docker-compose.yml"
scp "${SSH_OPTS[@]}" db/01-schema.sql db/02-functions.sql "$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_DIR/db/"

echo "==> starting"
remote bash -s <<REMOTE
set -euo pipefail
cd '$DEPLOY_DIR'
# the only secret: generated here, never leaves the server, never in the repo
if [ ! -f .env ]; then
  umask 077
  echo "POSTGRES_PASSWORD=\$(openssl rand -hex 24)" > .env
fi
sed -i '/^IMAGE_TAG=/d;/^WEB_PORT=/d' .env
echo "IMAGE_TAG=$TAG" >> .env
echo "WEB_PORT=$WEB_PORT" >> .env
docker compose up -d --remove-orphans --force-recreate web api
docker compose up -d martin db
docker compose ps
REMOTE
echo "==> done: http://$DEPLOY_HOST:$WEB_PORT/"
