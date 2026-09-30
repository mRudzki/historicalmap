# History of Europe on a map

Click a point on a map or globe of Europe and see which state or pre-state polity that place
belonged to. A year slider colours every polity's borders differently, and clicking shows the
history of that place over time.

Two modes: **Year** (slider; a click shows the polity in that year plus the place's history) and
**Pin** (a click drops a pin and outlines every polity that ever held the place, with a faint fill).

An educational project: borders are approximate.

## Quick start

Requires Docker and Node 24.

```bash
docker compose up -d --wait      # PostGIS, Martin (tiles), API
scripts/fetch-data.sh            # downloads Historical Basemaps into data/
npm install
npm run import                   # loads the data into the database
npm run dev -w apps/web          # http://localhost:5174
```

By default snapshots from year 1 AD onwards are imported; set `MIN_YEAR` (e.g. `MIN_YEAR=-500`)
to include older ones.

Ports: database `5433`, Martin `3100`, API `3001`, frontend `5174`
(`VITE_API_URL` and `VITE_TILES_URL` override the frontend's backends).

## Architecture

PostGIS stores the border snapshots. Martin streams vector tiles (MVT) from the SQL function
`polities_tile(z, x, y, query_params)` (the year is passed as `?year=`). A thin Fastify API
answers `/snapshots`, `/at?lat=&lon=&year=`, `/timeline?lat=&lon=` and `/history?lat=&lon=`
(GeoJSON contours). The frontend (Vite + MapLibre GL, globe projection) renders the tiles and the panel.
UI text lives in `apps/web/src/strings.ts`.

## Tests

```bash
docker compose up -d --wait db
npm test                 # backend (Vitest + PostGIS) and frontend logic
npm run typecheck
# e2e (needs the running stack and test data; tests the production build):
DATA_DIR=db/fixtures npm run import   # NOTE: replaces the database contents with test data
cd apps/web && npx playwright test
npm run import                         # then restore the real data
```

## Data

Borders come from [Historical Basemaps](https://github.com/aourednik/historical-basemaps)
(GPL-3.0) by Andrew Ourednik. The data is not part of this repository; `scripts/fetch-data.sh`
downloads it. The author notes it is approximate and a work in progress.

## Legal pages

The site ships a Privacy Policy (`apps/web/privacy.html`) and a Legal Notice (`apps/web/legal.html`), linked from the map footer together with the GitHub repository. If you deploy your own instance, replace the operator details in both pages with your own.

## License

GPL-3.0 (see `LICENSE`).
