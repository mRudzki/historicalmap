#!/usr/bin/env bash
# Attaches a domain to the app behind the server's shared nginx ("edge-proxy" container): an HTTP block for
# the ACME challenge + redirect, a Let's Encrypt certificate, then the HTTPS block proxying to the app.
# Idempotent; backs up the proxy config and rolls back if nginx rejects the result.
#
#   deploy/add-domain.sh historymaps.world            # also handles www.historymaps.world
#   deploy/add-domain.sh historymaps.world --print    # only print the nginx blocks (no server access)
#
# The DNS A records of the domain (and of www.) must already point at the server.
set -euo pipefail

DOMAIN="${1:?usage: add-domain.sh <domain> [--print]}"
MODE="${2:-apply}"
PORT_DEFAULT=8082

render_http() { # <server_names>
  cat <<EOF

# --- $DOMAIN (added by deploy/add-domain.sh) ---
server {
    listen 80;
    server_name $1;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF
}

render_https() { # <server_names> <port>
  cat <<EOF

server {
    listen 443 ssl;
    server_name $1;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    # the app's own nginx handles gzip and caching; /api and /tiles are proxied from there
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:$2;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
}

if [ "$MODE" = "--print" ]; then
  render_http "$DOMAIN www.$DOMAIN"
  render_https "$DOMAIN www.$DOMAIN" "$PORT_DEFAULT"
  exit 0
fi

source "$(dirname "$0")/lib.sh"
PORT="${WEB_PORT:-$PORT_DEFAULT}"
CONF=/root/edge-proxy/default.conf

echo "==> checking DNS"
resolves_to_server() { [ "$(dig +short A "$1" @1.1.1.1 | tail -1)" = "$DEPLOY_HOST" ]; }
NAMES="$DOMAIN"; CERT_ARGS=(-d "$DOMAIN")
resolves_to_server "$DOMAIN" || { echo "$DOMAIN does not resolve to $DEPLOY_HOST yet (create its A record and wait for DNS)." >&2; exit 1; }
if resolves_to_server "www.$DOMAIN"; then NAMES="$DOMAIN www.$DOMAIN"; CERT_ARGS+=(-d "www.$DOMAIN"); else echo "(no A record for www.$DOMAIN: it will not be included)"; fi

HTTP_BLOCK="$(render_http "$NAMES")"
HTTPS_BLOCK="$(render_https "$NAMES" "$PORT")"

echo "==> configuring the edge proxy on $DEPLOY_HOST"
# The config file is bind-mounted into the container: it must be edited in place (>> / cat >), never
# replaced (mv, sed -i), or the container keeps seeing the old inode.
remote bash -s -- "$DOMAIN" "$HTTP_BLOCK" "$HTTPS_BLOCK" "${CERT_ARGS[*]}" <<'REMOTE'
set -euo pipefail
domain="$1"; http_block="$2"; https_block="$3"; cert_args="$4"
conf=/root/edge-proxy/default.conf
backup="$conf.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$conf" "$backup"
echo "backup: $backup"

rollback() { echo "nginx rejected the config: restoring $backup" >&2; cat "$backup" > "$conf"; docker exec edge-proxy nginx -s reload </dev/null || true; exit 1; }
reload() { docker exec edge-proxy nginx -t </dev/null || rollback; docker exec edge-proxy nginx -s reload </dev/null; }

if grep -q "listen 443 ssl;" "$conf" && grep -q "live/$domain/" "$conf"; then
  echo "$domain is already configured: nothing to do"; exit 0
fi

if ! grep -q "server_name $domain" "$conf"; then
  printf '%s\n' "$http_block" >> "$conf"
  reload
fi

certbot certonly --webroot -w /root/edge-proxy/webroot $cert_args --non-interactive --agree-tos \
  </dev/null || { echo "certbot failed: the HTTP block stays, the HTTPS block was not added" >&2; exit 1; }

printf '%s\n' "$https_block" >> "$conf"
reload
echo "edge proxy updated"
REMOTE

echo "==> verifying https://$DOMAIN"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 --resolve "$DOMAIN:443:$DEPLOY_HOST" "https://$DOMAIN/")"
echo "https://$DOMAIN/ -> $code"
[ "$code" = "200" ] || { echo "unexpected status; the backup of the proxy config is on the server (default.conf.bak-*)" >&2; exit 1; }

echo "==> closing the public port $PORT (the proxy reaches the app on 127.0.0.1)"
remote bash -s <<REMOTE
set -euo pipefail
cd '$DEPLOY_DIR'
sed -i '/^WEB_BIND=/d' .env
echo 'WEB_BIND=127.0.0.1' >> .env
docker compose up -d web </dev/null
REMOTE
echo "==> done: https://$DOMAIN/"
