#!/usr/bin/env bash
# Downloads the Natural Earth 10m land mask (public domain) to data/land/ne_10m_land.geojson.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/land
file=data/land/ne_10m_land.geojson
if [ -s "$file" ]; then echo "Already have $file"; exit 0; fi
curl -fL -o "$file.part" "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson"
mv "$file.part" "$file"
echo "Land mask ready in $file (source: Natural Earth, public domain)"
