# History of Europe on a map

Click a point on a map or globe of Europe and see which state or pre-state polity that place
belonged to. A year slider colours every polity's borders differently, and clicking shows the
history of that place over time.

Two modes: **Year** (slider; a click shows the polity in that year plus the place's history) and
**Pin** (a click drops a pin; the default **Rewind** view steps back through the periods the place belonged to, newest first, with the contour of each period and, optionally, the map of that year; **All** outlines every polity that ever held the place at once). Rewind loads the periods page by page (`/history?limit=&offset=`): a small first page for a fast start, the next pages in the background ahead of the user. In Pin mode you can also type coordinates (`54.35, 18.65`, `54.35N 18.65E`) instead of clicking.

An educational project: borders are approximate.

## Quick start

Requires Docker and Node 24.

```bash
docker compose up -d --wait      # PostGIS, Martin (tiles), API
scripts/fetch-data.sh            # downloads Historical Basemaps into data/
npm install
npm run import                   # loads Historical Basemaps (approximate, fallback)
npm run import:ohm               # loads OpenHistoricalMap (preferred): downloads ~1.3 GB, needs Docker, ~10 min
npm run dev -w apps/web          # http://localhost:5174
```

The importers load a land mask ([Natural Earth](https://www.naturalearthdata.com/), public domain, ~10 MB,
downloaded by `scripts/fetch-land.sh`) on first use and clip every border to the land: modern OpenHistoricalMap
countries are outlines of territorial waters, which makes coastlines look like chains of circles.
`npm run import:land` reloads the mask; `npm run clip` loads it and clips geometries that are already in the
database (useful for a database imported before this existed; it takes a while on the full data set).

Both imports work on their own and only reload their own source. Upgrading from an older
snapshot-based database? Run `docker compose down -v` first and import again.

By default Historical Basemaps snapshots from year 1 AD onwards are imported, and OpenHistoricalMap
periods that ended before year 1 are dropped; set `MIN_YEAR` (e.g. `MIN_YEAR=-500`) to change both.

Ports: database `5433`, Martin `3100`, API `3001`, frontend `5174`
(`VITE_API_URL` and `VITE_TILES_URL` override the frontend's backends).

## Architecture

PostGIS stores every border as a time interval (`valid_from`/`valid_to`, decimal years) with a
`source` (`ohm` or `hb`) and an `admin_level` (2 = state, 3-4 = regions). OpenHistoricalMap wins;
Historical Basemaps fills the gaps: on the map the HB layer (`fallback`) is drawn under the OHM layer
(`polities`), and the API resolves the same precedence per place and date. Martin streams vector tiles (MVT)
from the SQL function `polities_tile(z, x, y, query_params)` (the year is passed as `?year=`; layers
`fallback`, `polities`, `regions`). A thin Fastify API answers `/range`, `/at?lat=&lon=&year=`,
`/timeline?lat=&lon=` and `/history?lat=&lon=&levels=[&limit=&offset=]` (GeoJSON contours; paged = one feature per period, newest first). The frontend (Vite +
MapLibre GL, globe projection) renders the tiles and the panel. UI text lives in `apps/web/src/strings.ts`.
Martin runs with its in-memory tile cache disabled (`--cache-size 0`) in `docker-compose.yml`: with the cache on it keeps serving the old tiles after an import until it is restarted. In production put an HTTP cache/CDN in front and purge it after an import.
Every geometry is stored three times: full (tiles from z8), `geom_lookup` (~200 m tolerance: point lookups and z6-z7 tiles, so the
hot data set is ~190 MB) and `geom_simple` (~2 km: z0-z5 tiles and the `/history` contours).
OHM is loaded from the daily planet dump with `osm2pgsql` (Docker, `db/ohm.lua`) into a staging schema,
then transformed by `scripts/import-ohm.ts`.

## Tests

```bash
docker compose up -d --wait db
npm test                 # backend (Vitest + PostGIS) and frontend logic
npm run typecheck
# e2e: an isolated stack (database historicalmap_e2e, API :3002, tiles :3101, web :5175) with the
# test fixtures; it never touches your dev data
npm run e2e
```

## Data

Borders come from two sources. [OpenHistoricalMap](https://www.openhistoricalmap.org/) (preferred;
day-precise dates; data dedicated to the public domain under CC0; features tagged with a share-alike
licence are skipped by the importer). [Historical Basemaps](https://github.com/aourednik/historical-basemaps)
(GPL-3.0) by Andrew Ourednik fills the gaps; it is approximate and marked as such. The data is not part of
this repository; `scripts/fetch-data.sh` and `scripts/fetch-ohm.sh` download it.

## Deployment

See [`deploy/README.md`](deploy/README.md): a small compose stack shipped over SSH (no registry, no secrets in the repo), plus a guide to running several apps with different domain names behind one reverse proxy on a single IP.

## Legal pages

The site ships a Privacy Policy (`apps/web/privacy.html`) and a Legal Notice (`apps/web/legal.html`), linked from the map footer together with the GitHub repository. If you deploy your own instance, replace the operator details in both pages with your own.

## License

GPL-3.0 (see `LICENSE`).
