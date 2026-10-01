#!/usr/bin/env bash
# Tests deploy/add-domain.sh without a server: the "remote" part runs locally (ADD_DOMAIN_LOCAL=1) against a
# temporary copy of the proxy config, with stubbed docker/certbot/dig/curl.
set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/hm"
ORIGINAL=$'server {\n    listen 80 default_server;\n    server_name _;\n}\n'

cat > "$T/bin/docker" <<'S'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
case "$*" in
  *"nginx -t"*) exit "${FAKE_NGINX_T_RC:-0}" ;;
esac
exit 0
S
cat > "$T/bin/certbot" <<'S'
#!/usr/bin/env bash
echo "certbot $*" >> "$STUB_LOG"
exit "${FAKE_CERTBOT_RC:-0}"
S
cat > "$T/bin/dig" <<'S'
#!/usr/bin/env bash
echo 203.0.113.9
S
cat > "$T/bin/curl" <<'S'
#!/usr/bin/env bash
echo 200
S
chmod +x "$T/bin/"*

run() { # prints the exit code on the last line
  ADD_DOMAIN_LOCAL=1 EDGE_CONF="$T/default.conf" STUB_LOG="$T/log" PATH="$T/bin:$PATH" \
    DEPLOY_HOST=203.0.113.9 DEPLOY_DIR="$T/hm" WEB_PORT=8082 \
    deploy/add-domain.sh example.test > "$T/out" 2>&1
  echo $?
}
printf '%s' "$ORIGINAL" > "$T/original"
fresh() { cp "$T/original" "$T/default.conf"; rm -f "$T"/default.conf.bak-* "$T/log"; touch "$T/log"; }
fails=0
ok()   { echo "ok   $1"; }
fail() { echo "FAIL $1"; sed 's/^/     | /' "$T/out" 2>/dev/null | tail -8; fails=$((fails + 1)); }
count() { grep -c "$1" "$T/default.conf" || true; }

echo "# attaches a domain"
fresh; rc="$(run)"
[ "$rc" = 0 ] && ok "exit code 0" || fail "exit code $rc"
[ "$(count 'server_name example.test www.example.test')" = 2 ] && ok "HTTP and HTTPS blocks added (www included)" || fail "blocks"
grep -q 'live/example.test/fullchain.pem' "$T/default.conf" && grep -q 'proxy_pass http://127.0.0.1:8082' "$T/default.conf" && ok "certificate path and upstream port" || fail "https block content"
head -4 "$T/default.conf" | diff -q - <(printf '%s' "$ORIGINAL" | head -4) >/dev/null && ok "original config preserved untouched at the top" || fail "original config altered"
ls "$T"/default.conf.bak-* >/dev/null 2>&1 && ok "backup created" || fail "no backup"
grep -q 'certbot certonly --webroot -w /root/edge-proxy/webroot -d example.test -d www.example.test' "$T/log" && ok "certbot asked for both names" || fail "certbot call"
[ "$(grep -c 'nginx -s reload' "$T/log")" -ge 2 ] && ok "nginx reloaded after each block" || fail "reloads"
grep -q 'WEB_BIND=127.0.0.1' "$T/hm/.env" 2>/dev/null && ok "public app port closed (WEB_BIND)" || fail "WEB_BIND not set"

echo "# idempotent"
before="$(cat "$T/default.conf")"; rc="$(run)"
[ "$rc" = 0 ] && [ "$(cat "$T/default.conf")" = "$before" ] && ok "second run changes nothing" || fail "second run changed the config"

echo "# rollback when nginx rejects the config"
fresh; export FAKE_NGINX_T_RC=1; rc="$(run)"; unset FAKE_NGINX_T_RC
[ "$rc" != 0 ] && cmp -s "$T/default.conf" "$T/original" && ok "config restored, non-zero exit" || fail "no rollback (rc=$rc)"

echo "# certbot failure"
fresh; export FAKE_CERTBOT_RC=1; rc="$(run)"; unset FAKE_CERTBOT_RC
[ "$rc" != 0 ] && [ "$(count 'listen 443 ssl')" = 0 ] && [ "$(count 'server_name example.test')" = 1 ] && ok "HTTP block kept, HTTPS block not added" || fail "certbot failure handling (rc=$rc)"

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
