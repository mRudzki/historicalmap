#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
if [ -d data/historical-basemaps/.git ]; then
  git -C data/historical-basemaps pull --ff-only
else
  git clone --depth 1 https://github.com/aourednik/historical-basemaps.git data/historical-basemaps
fi
echo "Data ready in data/historical-basemaps/geojson (source: Historical Basemaps, GPL-3.0)"
