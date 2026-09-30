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

New `scripts/import-ohm.ts`:
1. Overpass (`overpass-api.openhistoricalmap.org`): list relation ids (`boundary=administrative`, `admin_level` 2-4, with `start_date`, Europe bbox), then fetch geometry in batches of ~50 ids with a pause between requests and a descriptive `User-Agent`. Raw responses are cached in `data/ohm/` (git-ignored); a re-import does not hit the server.
2. `osmtogeojson` assembles multipolygons from the relations.
3. Same geometry pipeline as HB.
4. Name = `name:en`, else `name`.
5. Dates: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, negative years (`-0027`). A start date expands to the beginning of its period, an end date to the end of its period. A missing `end_date` means open-ended. Relations whose dates cannot be parsed are skipped and counted.
6. Features with a `license` tag containing share-alike (CC BY-SA) are skipped and counted, so the served output carries no terms conflicting with the GPL-3.0 code; CC BY features are kept with attribution. The tag is stored.
7. Reload is per source, transactional and idempotent: importing OHM never removes HB rows and vice versa. The report lists imported / skipped-unparsable-date / skipped-license counts.

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
- Map attribution: "Borders: OpenHistoricalMap (CC0), Historical Basemaps (GPL-3.0)". The Legal Notice credits OHM (courtesy, not required by CC0). The Privacy Policy is unchanged: the browser still loads everything from our servers; only the import script talks to Overpass.

## Errors

- Overpass failure (HTTP error, timeout) aborts the OHM import without touching the database; cached batches are reused on retry.
- All existing API validation and empty-result behaviour is kept (`200` + empty list for a place with no data; `400` for bad coordinates or year).

## Testing

- Pure functions: OHM date parser and `resolveTimeline` (including the Alsace case, gap tolerance, adjacent and overlapping intervals).
- PostGIS integration with offline fixtures in Overpass JSON format (`db/fixtures/ohm/`): polygon assembly, `name:en` preference, unparsable-date and share-alike skips, per-source idempotency, the three tile layers, precedence in `/at`, merging in `/timeline`, levels in `/history`.
- Overpass client with an injected `fetch` (batching, pause, cache). Real network only in a manual smoke step.
- E2E: year input, "Regions" checkbox, "(approximate)" marker.
- Manual, recorded: on real data Colmar shows `Deutsches Reich` for 1871–1918.

## Delivery order

1. Interval schema + HB importer (pure port; all existing tests stay green).
2. OHM date parser and `resolveTimeline`.
3. OHM import.
4. API: precedence, `/range`, `/at` regions, `/timeline`, `/history?levels=`.
5. Three-layer tiles.
6. UI.
7. Legal pages, README, attribution.

## Out of scope

Levels above 4, OHM features outside the Europe bbox, a language switcher, editing data, and a synced local copy of the OHM database (planet dump).
