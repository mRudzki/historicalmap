# OpenHistoricalMap as a second, preferred data source — design

Extends `2026-09-30-historical-europe-map-design.md`. Where the two differ, this document wins.

## Problem

Historical Basemaps (HB) is coarse and sometimes wrong (e.g. it draws Alsace as French in the 1878/1880/1900 snapshots and omits Metz's German period), and its sparse snapshots make date ranges look precise when they are not. OpenHistoricalMap (OHM) has day-precise `start_date`/`end_date` and, for Alsace, `Elsaß-Lothringen` 1871-05-10 → 1918-11-11 and `Deutsches Reich` with exact dates.

## Decisions (agreed with the owner)

- Model: **one interval model** for both sources (not separate schemas, not pre-merged maps).
- Precedence: **OHM wins; HB fills the gaps** where OHM has no coverage (per place and date).
- Scope: OHM `boundary=administrative` relations with `admin_level` **2, 3 and 4**, inside the Europe bbox (west -25, south 34, east 45, north 72). Level 2 is "state" (fill colour); levels 3-4 are "regions" (outlines and list entries only).
- OHM data is CC0 (per openhistoricalmap.org/copyright); individual features may carry a `license=*` tag.

## Data model

Time is a decimal year (`double precision`): 1918-11-11 ≈ 1918.86. `valid_to = NULL` means "still valid". A query for year Y uses `t = Y + 0.5`, so a transition year resolves to a single polity (1918 → German Empire, 1919 → France).

- `polities(id, name, admin_level, UNIQUE(name, admin_level))`. Colour still derives from `name` alone, so the same name has the same colour across sources and levels.
- `polity_geometries(polity_id, source, valid_from, valid_to, geom geometry(MultiPolygon,4326), border_precision)`, `source IN ('ohm','hb')`, GiST index on `geom`, btree index on `(source, valid_from, valid_to)`. The `snapshots` table is removed.
- HB snapshot Y with next snapshot N becomes `[Y, N)`; the last snapshot is open-ended. HB rows get `admin_level = 2`.
- Migration is not backwards compatible. `applySchema` detects the old schema (a `snapshots` table) and aborts with: run `docker compose down -v` and re-import. It never drops data silently.

## Import

HB importer keeps its pipeline (`ST_Force2D`, `ST_MakeValid`, latitude clip to ±85, Europe filter) but writes intervals and deletes/reloads only `source='hb'` rows in one transaction.

New OHM import, from the daily **planet dump** (spike result: Overpass was rejected, ~6-7 GB of JSON for levels 2-4 because every relation carries its own copy of shared borders and it loads a community server; the planet dump is ~1.3 GB, shared ways are stored once):
1. `scripts/fetch-ohm.sh` downloads the latest `planet-*.osm.pbf` from `s3.amazonaws.com/planet.openhistoricalmap.org/planet/` into `data/ohm/` (git-ignored, resumable, skipped when already present).
2. `osm2pgsql` (run from the multi-arch Docker image `iboates/osm2pgsql`, nothing installed locally) with a flex Lua style (`db/ohm.lua`), `--slim` with a flat-nodes file and the Europe bbox, loads boundary relations (`boundary=administrative`, `admin_level` in 2-4, with a `start_date`) as multipolygons into a staging table `ohm_staging(osm_id, tags jsonb, geom)`, in a separate schema `ohm_stage`.
3. `scripts/import-ohm.ts` transforms staging into `polities` / `polity_geometries` inside one transaction (see the per-source reload below) and then drops the staging table:
   - same geometry pipeline as HB (`ST_Force2D`, `ST_MakeValid`, latitude clip to ±85, Europe filter);
   - name = `name:en`, else `name`;
   - dates: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, negative years (`-0027`). A start date expands to the beginning of its period, an end date to the end of its period. A missing `end_date` means open-ended. Relations whose dates cannot be parsed are skipped and counted (the parser is a pure TypeScript function; rows are read from the staging table and parsed in TS);
   - features with a `license` tag containing share-alike (CC BY-SA) are skipped and counted, so the served output carries no terms conflicting with the GPL-3.0 code; CC BY features are kept with attribution. The tag is stored;
   - the reload is per source, transactional and idempotent: importing OHM never removes HB rows and vice versa.
   The report lists imported / skipped-unparsable-date / skipped-license counts.

`MIN_YEAR` (default 1) applies to both sources: intervals that end before it are dropped.

## Queries and tiles

- **Tile** `polities_tile(z,x,y,query_params)`: `year` → `t`. Three MVT layers concatenated in one tile: `fallback` (HB valid at `t`), `polities` (OHM level 2 valid at `t`), `regions` (OHM levels 3-4 valid at `t`, property `level`). Precedence is layer order: `polities` is drawn opaque above `fallback`. Missing / non-numeric / out-of-range year → empty tile.
- **`GET /range`** → `{min, max}`; replaces `/snapshots`. `max` is the current year; `min` is the earliest `valid_from` in the database, rounded down (the importer already dropped anything before `MIN_YEAR`). `/at` with a year outside the range → 400.
- **`GET /at?lat&lon&year`** → `{year, polities:[…], regions:[…]}`. `polities` are level 2: OHM if any covers the point at `t`, else HB. `regions` are OHM levels 3-4 ordered by level. Every entry carries `source` (`ohm`|`hb`). `snapshotYear` is removed.
- **`GET /timeline?lat&lon`** (level 2): pure function `resolveTimeline(ohmIntervals, hbIntervals)` (1) subtracts the union of OHM intervals from every HB interval; (2) merges same-name intervals that touch, overlap or are less than 1 year apart (tunable constant); (3) sorts by start. The panel shows years rounded down. Example: OHM `Deutsches Reich` 1871–1918 beats HB `France` 1715–1914 and leaves HB `France` for 1715–1871.
- **`GET /history?lat&lon[&levels=2,3,4]`** (default `levels=2`): one contour per polity = union of its geometries from all sources; an HB polity is included only if it keeps some interval after `resolveTimeline`. Entries carry `from`, `to`, `periods`, `level`, `source`.

## UI

- Year slider over integer years from `/range`, step 1, plus a number input synchronised with it (typing 1871 jumps there). Tile reload is debounced (~150 ms).
- One "Regions" checkbox (default off) in both modes. Year mode: shows the `regions` layer as thin outlines and lists regions indented under the state in the panel. Pin mode: requests `levels=2,3,4` and shows those contours/entries.
- Entries with `source='hb'` get "(approximate)". On the map `fallback` is drawn at ~0.55 opacity and `polities` at 1.0, so paler areas read as approximate.
- Map attribution: "Borders: OpenHistoricalMap (CC0), Historical Basemaps (GPL-3.0)". The Legal Notice credits OHM (courtesy, not required by CC0). The Privacy Policy is unchanged: the browser still loads everything from our servers; only the import scripts download the OHM planet dump.

## Errors

- A failed download or `osm2pgsql` run aborts the OHM import without touching `polities` / `polity_geometries`; the resumable download is reused on retry.
- All existing API validation and empty-result behaviour is kept (`200` + empty list for a place with no data; `400` for bad coordinates or year).

## Testing

- Pure functions: OHM date parser and `resolveTimeline` (including the Alsace case, gap tolerance, adjacent and overlapping intervals).
- PostGIS integration with offline fixtures in Overpass JSON format (`db/fixtures/ohm/`): polygon assembly, `name:en` preference, unparsable-date and share-alike skips, per-source idempotency, the three tile layers, precedence in `/at`, merging in `/timeline`, levels in `/history`.
- OHM staging → final transform tested from a hand-written staging fixture (SQL inserts of tags + geometry), so the Docker/osm2pgsql step is not needed in unit tests. The osm2pgsql Lua style is verified in a manual smoke step against the real planet dump, with the result recorded.
- E2E: year input, "Regions" checkbox, "(approximate)" marker.
- Manual, recorded: on real data Colmar shows `Deutsches Reich` for 1871–1918.

## Delivery order

1. Interval schema + HB importer (pure port; all existing tests stay green).
2. OHM date parser and `resolveTimeline`.
3. OHM import (download script, osm2pgsql style, staging → final transform).
4. API: precedence, `/range`, `/at` regions, `/timeline`, `/history?levels=`.
5. Three-layer tiles.
6. UI.
7. Legal pages, README, attribution.

## Out of scope

Levels above 4, OHM features outside the Europe bbox, a language switcher, editing data, and keeping the OHM data up to date incrementally (each import re-processes a full dump).
