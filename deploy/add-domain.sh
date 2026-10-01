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

if [ "${ADD_DOMAIN_LOCAL:-0}" = "1" ]; then
  # test mode (deploy/test-add-domain.sh): run the "remote" script locally
  remote() { "$@"; }
  : "${DEPLOY_HOST:?}" "${DEPLOY_DIR:?}"
else
  source "$(dirname "$0")/lib.sh"
fi
PORT="${WEB_PORT:-$PORT_DEFAULT}"

echo "==> checking DNS"
# right after a change the public resolvers disagree for a while: ask two of them, a few times
resolves_to_server() {
  local try resolver
  for try in 1 2 3; do
    for resolver in 1.1.1.1 8.8.8.8; do
      [ "$(dig +short A "$1" "@$resolver" | tail -1)" = "$DEPLOY_HOST" ] && return 0
    done
    sleep 2
  done
  return 1
}
NAMES="$DOMAIN"; CERT_ARGS=(-d "$DOMAIN")
resolves_to_server "$DOMAIN" || { echo "$DOMAIN does not resolve to $DEPLOY_HOST yet (create its A record and wait for DNS)." >&2; exit 1; }
if resolves_to_server "www.$DOMAIN"; then NAMES="$DOMAIN www.$DOMAIN"; CERT_ARGS+=(-d "www.$DOMAIN"); else echo "(no A record for www.$DOMAIN: it will not be included)"; fi

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
HTTP_B64="$(b64 "$(render_http "$NAMES")")"
HTTPS_B64="$(b64 "$(render_https "$NAMES" "$PORT")")"

echo "==> configuring the edge proxy on $DEPLOY_HOST"
# The blocks travel base64-encoded on stdin together with the script: ssh joins its arguments into one command
# line, so multi-line arguments would be split and parsed by the remote shell.
# The config file is bind-mounted into the container: it must be edited in place (>> / cat >), never
# replaced (mv, sed -i), or the container keeps seeing the old inode.
{
  printf 'domain=%q; http_b64=%q; https_b64=%q; cert_args=%q; deploy_dir=%q\n' \
    "$DOMAIN" "$HTTP_B64" "$HTTPS_B64" "${CERT_ARGS[*]}" "$DEPLOY_DIR"
  cat <<'REMOTE'
set -euo pipefail
http_block="$(printf %s "$http_b64" | base64 --decode)"
https_block="$(printf %s "$https_b64" | base64 --decode)"
conf="${EDGE_CONF:-/root/edge-proxy/default.conf}"
backup="$conf.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$conf" "$backup"
echo "backup: $backup"

rollback() { echo "nginx rejected the config: restoring $backup" >&2; cat "$backup" > "$conf"; docker exec edge-proxy nginx -s reload </dev/null || true; exit 1; }
reload() { docker exec edge-proxy nginx -t </dev/null || rollback; docker exec edge-proxy nginx -s reload </dev/null; }

if grep -q "live/$domain/" "$conf"; then
  echo "$domain is already configured: nothing to do"
else
  if ! grep -q "server_name $domain" "$conf"; then
    printf '%s\n' "$http_block" >> "$conf"
    reload
  fi
  # shellcheck disable=SC2086
  certbot certonly --webroot -w /root/edge-proxy/webroot $cert_args --non-interactive --agree-tos \
    </dev/null || { echo "certbot failed: the HTTP block stays, the HTTPS block was not added" >&2; exit 1; }
  printf '%s\n' "$https_block" >> "$conf"
  reload
  echo "edge proxy updated"
fi

# the proxy reaches the app on 127.0.0.1, so the app port no longer needs to be public
mkdir -p "$deploy_dir"; touch "$deploy_dir/.env"
grep -v '^WEB_BIND=' "$deploy_dir/.env" > "$deploy_dir/.env.new" || true
echo 'WEB_BIND=127.0.0.1' >> "$deploy_dir/.env.new"
cat "$deploy_dir/.env.new" > "$deploy_dir/.env"; rm -f "$deploy_dir/.env.new"
REMOTE
} | remote bash -s

echo "==> verifying https://$DOMAIN"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 --resolve "$DOMAIN:443:$DEPLOY_HOST" "https://$DOMAIN/")"
echo "https://$DOMAIN/ -> $code"
[ "$code" = "200" ] || { echo "unexpected status; the backup of the proxy config is on the server (default.conf.bak-*)" >&2; exit 1; }

echo "==> closing the public port $PORT"
{ printf 'deploy_dir=%q\n' "$DEPLOY_DIR"; echo 'cd "$deploy_dir" && docker compose up -d web </dev/null'; } | remote bash -s
echo "==> done: https://$DOMAIN/"
