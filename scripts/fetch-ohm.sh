#!/usr/bin/env bash
# Downloads the newest daily OpenHistoricalMap planet dump to data/ohm/planet.osm.pbf (resumable).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/ohm
BASE="https://s3.amazonaws.com/planet.openhistoricalmap.org"

key=""
for back in $(seq 0 20); do
  d=$(date -u -v-"${back}"d +%y%m%d 2>/dev/null || date -u -d "-${back} day" +%y%m%d)
  key=$(curl -fsS "$BASE/?prefix=planet/planet-$d&max-keys=5" | grep -o "<Key>[^<]*\.osm\.pbf</Key>" | head -1 | sed 's/<[^>]*>//g' || true)
  [ -n "$key" ] && break
done
[ -n "$key" ] || { echo "No OHM planet dump found in the last 20 days" >&2; exit 1; }

target=data/ohm/planet.osm.pbf
if [ -f "$target" ] && [ "$(cat data/ohm/planet.key 2>/dev/null || true)" = "$key" ]; then
  echo "Already have $key"; exit 0
fi
# resume only a partial download of the same file
if [ "$(cat data/ohm/planet.part.key 2>/dev/null || true)" != "$key" ]; then rm -f "$target.part"; fi
echo "$key" > data/ohm/planet.part.key
echo "Downloading $key"
curl -fL -C - -o "$target.part" "$BASE/$key"
mv "$target.part" "$target" && echo "$key" > data/ohm/planet.key
