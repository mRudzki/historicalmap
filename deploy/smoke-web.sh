#!/usr/bin/env bash
# Starts the web image locally and checks what the browser needs: the MapLibre worker must be served with a
# JavaScript MIME type (module workers refuse anything else, and the map then silently stays empty).
# usage: deploy/smoke-web.sh <image>
set -euo pipefail
image="${1:?usage: smoke-web.sh <image>}"
name="hm-smoke-$$"
port=18082
docker run -d --rm --name "$name" -p "$port:80" "$image" >/dev/null
trap 'docker stop "$name" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 30); do curl -sf -o /dev/null "http://localhost:$port/" && break; sleep 0.5; done

fail=0
check() { # <path> <expected content-type regex>
  local type
  type="$(curl -sI "http://localhost:$port$1" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')"
  if [[ "$type" =~ $2 ]]; then echo "ok   $1 ($type)"; else echo "FAIL $1: got '$type', want /$2/" >&2; fail=1; fi
}
check /                                       'text/html'
check /legal.html                             'text/html'
check /maplibre/maplibre-gl-worker.mjs        'javascript'
check /maplibre/maplibre-gl-shared.mjs        'javascript'
exit $fail
