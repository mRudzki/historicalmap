# OpenHistoricalMap Second Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenHistoricalMap (OHM) as a preferred, day-precise second data source next to Historical Basemaps (HB): one interval-based model, OHM wins and HB fills gaps, admin levels 2-4, year slider over integer years.

**Architecture:** `polity_geometries` gets `source`, `valid_from`, `valid_to` (decimal years) and `polities` gets `admin_level`. HB snapshots become intervals. OHM is imported from the daily planet dump with `osm2pgsql` (flex Lua style, Docker) into a staging schema, then transformed in SQL + TypeScript into the final tables. Precedence: tile layer order (`fallback` under `polities`) and a pure `resolveTimeline` function in the API.

**Tech Stack:** unchanged (Node 24, TypeScript, Fastify, Vitest, PostGIS 17, Martin, Vite + MapLibre, Playwright) plus `iboates/osm2pgsql:2.3.1` (Docker, compose profile `tools`).

**Spec:** `docs/superpowers/specs/2026-09-30-ohm-second-source-design.md` (extends `2026-09-30-historical-europe-map-design.md`)

## Global Constraints

- Time is decimal years (`double precision`); `valid_to IS NULL` = still valid; queries for year Y use `at_time = Y + 0.5`. `valid_to > valid_from` is enforced by a CHECK.
- `polities` unique on `(name, admin_level)`; colour derives from `name` only (`polity_color(name)`, unchanged).
- `source IN ('ohm','hb')`; HB rows have `admin_level = 2`. Importers reload **only their own source**, in one transaction; nothing is dropped silently (old-schema detection aborts with a message).
- OHM levels 2-4 only, Europe bbox (west -25, south 34, east 45, north 72) applied **in SQL**; never pass `--bbox` to osm2pgsql (it breaks ring assembly, verified on the real dump).
- Geometry pipeline for both sources: `ST_Force2D`, `ST_MakeValid`, `ST_Intersection` with `ST_MakeEnvelope(-180,-85,180,85,4326)`, `ST_CollectionExtract(...,3)`, `ST_Multi`.
- OHM name = `name:en`, else `name`. Skip (and count) relations with unparsable or reversed dates and with a share-alike `license` tag.
- Tile function `polities_tile`, MVT layers `fallback` (HB), `polities` (OHM level 2), `regions` (OHM levels 3-4); properties `id`, `name`, `color`, `level`, `border_precision`.
- API: `GET /range`, `GET /at`, `GET /timeline`, `GET /history?levels=`; `/snapshots` is removed in Task 4. Validation as before (400 for bad coordinates / year; 200 + empty result for no data).
- Displayed period end: OHM `Math.floor(to - 1e-6)`, HB `Math.floor(to)` (HB end = next snapshot year); display start `Math.floor(from)`.
- UI text in English, all in `apps/web/src/strings.ts`. The Privacy Policy stays true: the browser loads only our own servers.
- Host ports: db 5433, Martin 3100, API 3001, web 5174.

## Review Focus

- Colmar/Metz on real data: `German Reich` 1871-1918 (OHM) beats HB's `France` up to 1914 (Task 3 manual check, Task 4 test with the same shape).
- OHM relation with end date before start date (present in real data) must be skipped, not crash or insert an invalid row (Task 2, Task 3).
- Re-importing one source must never delete the other source's rows (Task 1, Task 3).
- A year outside the data range → `400`; a year inside a gap of OHM coverage → HB fills it (Task 4).
- `/history` and `/timeline` at a point with no data → `200`, empty (Task 4).
- Old-schema database → clear abort message, no data loss (Task 1).
- Tile request with missing, non-numeric or out-of-range `year` → empty tile, not an error (Task 5).
- Typing a year outside `[min, max]` or non-numeric into the year input must not break the map (Task 6).

## File Structure

```
db/01-schema.sql            new tables (Task 1)
db/02-functions.sql         polity_color, polities_tile (+ polity_tile_layer in Task 5)
db/ohm.lua                  osm2pgsql flex style (already present, unchanged)
db/apply-schema.ts          + old-schema detection
db/global-setup.ts          recreates the test DB each run
db/test-support.ts          + seedOhmFixture
db/fixtures/ohm/staging.sql hand-written ohm_stage rows for tests and e2e
docker-compose.yml          + osm2pgsql service (profile "tools")
scripts/import-lib.ts       HB importer -> intervals
scripts/ohm-dates.ts        parseOhmInterval, isShareAlike (pure)
scripts/import-ohm-lib.ts   importOhmStaging(pool, opts)
scripts/import-ohm.ts       CLI: fetch + osm2pgsql + transform
scripts/fetch-ohm.sh        resumable planet download
apps/api/src/resolve-timeline.ts   resolveTimeline, displayPeriod (pure)
apps/api/src/app.ts         /range, /at, /timeline, /history
apps/web/src/{api,format,panel,pin-mode,main,strings}.ts, index.html, style.css
```

---

### Task 1: Interval schema and HB importer (behaviour-preserving port)

**Files:**
- Modify: `db/01-schema.sql`, `db/02-functions.sql`, `db/apply-schema.ts`, `db/global-setup.ts`, `db/test-support.ts`, `scripts/import-lib.ts`, `apps/api/src/app.ts`
- Test: `db/schema.test.ts`, `scripts/import.test.ts`, `db/tile.test.ts` (modify); `apps/api/test/app.test.ts` must pass **unchanged**

**Interfaces:**
- Produces: tables as in Global Constraints; `importDirectory(pool, dir, {minYear?})` unchanged signature/return `{snapshots, features}`; HB rows `source='hb'`, `valid_from = snapshot year`, `valid_to = next snapshot year | NULL`, polity `admin_level = 2`; `clearAll(pool)`; `applySchema(pool)` throws when a `snapshots` table exists.

- [ ] **Step 1: Update the tests first (RED)**

`db/schema.test.ts` (replace the whole file):
```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema } from './apply-schema';
import { clearAll, testPool } from './test-support';

const pool = testPool();
beforeEach(() => clearAll(pool));
afterAll(() => pool.end());

const sq = "ST_Multi(ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))',4326))";

describe('schema', () => {
  it('rejects two polities with the same name and level, allows the same name at another level', async () => {
    await pool.query("INSERT INTO polities (name, admin_level) VALUES ('Baden', 2)");
    await expect(pool.query("INSERT INTO polities (name, admin_level) VALUES ('Baden', 2)")).rejects.toThrow(/unique/i);
    await pool.query("INSERT INTO polities (name, admin_level) VALUES ('Baden', 4)");
  });

  it('rejects a non-MultiPolygon geometry', async () => {
    await pool.query("INSERT INTO polities (name) VALUES ('P')");
    await expect(
      pool.query("INSERT INTO polity_geometries (polity_id, source, valid_from, geom) VALUES (1, 'hb', 1000, ST_SetSRID(ST_MakePoint(1,1),4326))"),
    ).rejects.toThrow();
  });

  it('rejects an unknown source and an interval that ends before it starts', async () => {
    await pool.query("INSERT INTO polities (name) VALUES ('P')");
    await expect(
      pool.query(`INSERT INTO polity_geometries (polity_id, source, valid_from, geom) VALUES (1, 'xyz', 1000, ${sq})`),
    ).rejects.toThrow();
    await expect(
      pool.query(`INSERT INTO polity_geometries (polity_id, source, valid_from, valid_to, geom) VALUES (1, 'hb', 1000, 900, ${sq})`),
    ).rejects.toThrow();
  });

  it('refuses to run on the old snapshot-based schema without dropping anything', async () => {
    await pool.query('CREATE TABLE snapshots (id int)');
    try {
      await expect(applySchema(pool)).rejects.toThrow(/docker compose down -v/);
    } finally {
      await pool.query('DROP TABLE snapshots');
    }
  });
});
```
In `scripts/import.test.ts` change the two `snapshots` queries:
```ts
    const years = await pool.query('SELECT DISTINCT valid_from::int AS year FROM polity_geometries ORDER BY 1');
```
(both occurrences, replacing `SELECT year FROM snapshots ORDER BY year`), and add these tests inside `describe('importDirectory', …)`:
```ts
  it('stores each snapshot as an interval up to the next snapshot; the last one is open', async () => {
    await importDirectory(pool, FIXTURE_DIR);
    const rows = await pool.query(
      `SELECT p.name, g.source, p.admin_level, g.valid_from, g.valid_to
       FROM polity_geometries g JOIN polities p ON p.id = g.polity_id
       WHERE p.name = 'Kingdom B' ORDER BY g.valid_from, g.valid_to NULLS LAST`,
    );
    expect(rows.rows).toEqual([
      { name: 'Kingdom B', source: 'hb', admin_level: 2, valid_from: 1000, valid_to: 1100 },
      { name: 'Kingdom B', source: 'hb', admin_level: 2, valid_from: 1100, valid_to: null },
      { name: 'Kingdom B', source: 'hb', admin_level: 2, valid_from: 1100, valid_to: null },
    ]);
  });

  it('reloads only HB rows and keeps OHM rows', async () => {
    await pool.query("INSERT INTO polities (name, admin_level) VALUES ('Ohm Realm', 2)");
    await pool.query(
      `INSERT INTO polity_geometries (polity_id, source, valid_from, geom)
       VALUES (1, 'ohm', 1500, ST_Multi(ST_GeomFromText('POLYGON((0 40,1 40,1 41,0 41,0 40))',4326)))`,
    );
    await importDirectory(pool, FIXTURE_DIR);
    const ohm = await pool.query("SELECT count(*)::int AS n FROM polity_geometries WHERE source = 'ohm'");
    expect(ohm.rows[0].n).toBe(1);
  });
```
`db/tile.test.ts`: delete the whole `describe('snapshot_for_year', …)` block (the function is removed); everything else stays.

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run db scripts`
Expected: FAIL (schema tests fail: columns/constraints missing; import tests fail on `valid_from`).

- [ ] **Step 3: Implement schema, setup and detection**

`db/01-schema.sql` (replace):
```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS polities (
  id serial PRIMARY KEY,
  name text NOT NULL,
  admin_level smallint NOT NULL DEFAULT 2,
  UNIQUE (name, admin_level)
);

CREATE TABLE IF NOT EXISTS polity_geometries (
  polity_id integer NOT NULL REFERENCES polities(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('ohm', 'hb')),
  valid_from double precision NOT NULL,
  valid_to double precision,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  border_precision smallint,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX IF NOT EXISTS polity_geometries_geom_idx
  ON polity_geometries USING gist (geom);
CREATE INDEX IF NOT EXISTS polity_geometries_time_idx
  ON polity_geometries (source, valid_from, valid_to);
```
`db/apply-schema.ts` (replace):
```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));

// Idempotent: safe to run on an existing database (initdb.d only runs on first init).
// Never drops data: an old snapshot-based database must be recreated by the user.
export async function applySchema(pool: pg.Pool): Promise<void> {
  const old = await pool.query("SELECT to_regclass('public.snapshots') IS NOT NULL AS old");
  if (old.rows[0].old) {
    throw new Error(
      'Old snapshot-based schema detected. Run "docker compose down -v" and re-import (the data is reproducible from its sources).',
    );
  }
  for (const file of ['01-schema.sql', '02-functions.sql']) {
    await pool.query(await readFile(path.join(here, file), 'utf8'));
  }
}
```
`db/global-setup.ts`: replace the create-if-missing block with a fresh database each run:
```ts
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
```
(delete the `exists` query and the `if (!exists.rowCount)` line). `db/test-support.ts`: `clearAll` becomes
```ts
export async function clearAll(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE polity_geometries, polities RESTART IDENTITY CASCADE');
}
```
`db/02-functions.sql`: delete `snapshot_for_year`, keep `polity_color`, and replace `polities_tile` with the HB-interval version (layer name still `polities`):
```sql
DROP FUNCTION IF EXISTS snapshot_for_year(integer);

CREATE OR REPLACE FUNCTION polities_tile(z integer, x integer, y integer, query_params json DEFAULT '{}')
RETURNS bytea LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  year_text text := query_params->>'year';
  at_time double precision;
  bounds geometry := ST_TileEnvelope(z, x, y);
  result bytea;
BEGIN
  IF year_text IS NULL OR year_text !~ '^-?[0-9]{1,6}$' THEN
    RETURN ''::bytea;
  END IF;
  at_time := year_text::integer + 0.5;

  SELECT ST_AsMVT(t, 'polities', 4096, 'geom') INTO result
  FROM (
    SELECT p.id, p.name, polity_color(p.name) AS color, g.border_precision,
           ST_AsMVTGeom(ST_Transform(g.geom, 3857), bounds, 4096, 64, true) AS geom
    FROM polity_geometries g
    JOIN polities p ON p.id = g.polity_id
    WHERE g.source = 'hb'
      AND g.valid_from <= at_time AND (g.valid_to IS NULL OR g.valid_to > at_time)
      AND g.geom && ST_Transform(bounds, 4326)
  ) t
  WHERE t.geom IS NOT NULL;

  RETURN COALESCE(result, ''::bytea);
END
$$;
```
- [ ] **Step 4: Port the HB importer**

In `scripts/import-lib.ts` replace `INSERT_FEATURE`, the `Feature` interface and the body of `importDirectory`'s transaction:
```ts
interface Feature {
  properties: { NAME?: string | null; BORDERPRECISION?: number | null };
  geometry: unknown;
}

const INSERT_FEATURE = `
WITH g AS (
  SELECT ST_Multi(ST_CollectionExtract(
    ST_Intersection(
      ST_MakeValid(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326))),
      ST_MakeEnvelope(-180, -85, 180, 85, 4326)),
    3)) AS geom
), keep AS (
  SELECT geom FROM g
  WHERE NOT ST_IsEmpty(geom)
    AND ST_Intersects(geom, ST_MakeEnvelope($2::float8, $3::float8, $4::float8, $5::float8, 4326))
), p AS (
  INSERT INTO polities (name, admin_level)
  SELECT $6::text, 2 FROM keep
  ON CONFLICT (name, admin_level) DO UPDATE SET name = EXCLUDED.name
  RETURNING id
)
INSERT INTO polity_geometries (polity_id, source, valid_from, valid_to, geom, border_precision)
SELECT p.id, 'hb', $7::float8, $8::float8, keep.geom, $9::smallint FROM p, keep`;
```
and inside the transaction:
```ts
    await client.query('BEGIN');
    await client.query("DELETE FROM polity_geometries WHERE source = 'hb'");
    for (const [i, snap] of parsed.entries()) {
      const validTo = parsed[i + 1]?.year ?? null;
      for (const feat of snap.features) {
        if (!feat.geometry) continue;
        const p = feat.properties;
        const res = await client.query(INSERT_FEATURE, [
          JSON.stringify(feat.geometry),
          EUROPE_BBOX.west, EUROPE_BBOX.south, EUROPE_BBOX.east, EUROPE_BBOX.north,
          p.NAME ?? UNNAMED, snap.year, validTo, p.BORDERPRECISION ?? null,
        ]);
        features += res.rowCount ?? 0;
      }
    }
    await client.query(
      'DELETE FROM polities p WHERE NOT EXISTS (SELECT 1 FROM polity_geometries g WHERE g.polity_id = p.id)',
    );
    await client.query('COMMIT');
```
(remove the `TRUNCATE`, the `INSERT INTO snapshots` and the `snapshotId` variable.)

- [ ] **Step 5: Keep the API behaving exactly as before**

In `apps/api/src/app.ts` change only the SQL, not the response shapes:
```ts
  const snapshotYears = async (): Promise<number[]> => {
    const { rows } = await pool.query(
      "SELECT DISTINCT valid_from::int AS year FROM polity_geometries WHERE source = 'hb' ORDER BY 1",
    );
    return rows.map((r) => r.year as number);
  };
```
`/at`: replace the two queries with
```ts
    const snap = await pool.query(
      "SELECT max(valid_from)::int AS year FROM polity_geometries WHERE source = 'hb' AND valid_from <= $1",
      [year],
    );
    const snapshotYear = snap.rows[0].year as number;
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (p.id) p.id, p.name,
              g.border_precision AS "borderPrecision", polity_color(p.name) AS color
       FROM polity_geometries g JOIN polities p ON p.id = g.polity_id
       WHERE g.source = 'hb' AND g.valid_from <= $3 AND (g.valid_to IS NULL OR g.valid_to > $3)
         AND ST_Intersects(g.geom, ${POINT})
       ORDER BY p.id, g.border_precision DESC NULLS LAST`,
      [lon, lat, year + 0.5],
    );
    return { year, snapshotYear, polities: rows };
```
`/timeline` query: `SELECT DISTINCT p.name, polity_color(p.name) AS color, g.valid_from::int AS year FROM polity_geometries g JOIN polities p ON p.id = g.polity_id WHERE g.source = 'hb' AND ST_Intersects(g.geom, ${POINT})`.
`/history` query: `array_agg(DISTINCT g.valid_from::int) AS years` with `FROM polity_geometries g JOIN polities p ON p.id = g.polity_id WHERE g.source = 'hb' AND ST_Intersects(g.geom, ${POINT}) GROUP BY p.id, p.name` (drop the `snapshots` join).

- [ ] **Step 6: Reset the dev database and run everything (GREEN)**

```bash
docker compose down -v && docker compose up -d --wait db
npm run import      # real HB data into the fresh schema
npx vitest run
npm run typecheck
```
Expected: all Vitest tests pass (the previous 45 + the 4 new schema/import tests, minus the removed `snapshot_for_year` test), `apps/api/test/app.test.ts` unmodified and green, typecheck clean. Also run `curl -s "localhost:3001/timeline?lat=48.08&lon=7.36"` against the restarted API (`docker compose up -d --build api`) and confirm HB behaviour (France until 1914) is unchanged.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor: interval-based schema, HB importer writes source/valid_from/valid_to

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: OHM date parser and timeline resolver (pure functions)

**Files:**
- Create: `scripts/ohm-dates.ts`, `apps/api/src/resolve-timeline.ts`
- Test: `scripts/ohm-dates.test.ts`, `apps/api/test/resolve-timeline.test.ts`

**Interfaces:**
- Produces: `parseOhmInterval(start: string | undefined, end: string | undefined): { from: number; to: number | null } | null`; `isShareAlike(license: string | undefined): boolean`; in `resolve-timeline.ts`: `Interval = {name, color, from, to: number|null}`, `Period = Interval & {source: 'ohm'|'hb'}`, `resolveTimeline(ohm: Interval[], hb: Interval[]): Period[]`, `displayPeriod(p: Period): {name, color, from: number, to: number | null, source}`.

- [ ] **Step 1: Write the failing tests**

`scripts/ohm-dates.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isShareAlike, parseOhmInterval } from './ohm-dates';

describe('parseOhmInterval', () => {
  it('start of a full date is the start of that day, end is the end of that day', () => {
    const r = parseOhmInterval('1871-05-04', '1918-11-11')!;
    expect(r.from).toBeCloseTo(1871 + 123 / 365, 6); // day 124 of 1871 -> 123 full days before
    expect(r.to).toBeCloseTo(1918 + 315 / 365, 6);
  });

  it('expands partial dates: start to the beginning, end to the end of the period', () => {
    expect(parseOhmInterval('1871', '1871')).toEqual({ from: 1871, to: 1872 });
    const m = parseOhmInterval('1871-03', '1871-03')!;
    expect(m.from).toBeCloseTo(1871 + 59 / 365, 6);
    expect(m.to).toBeCloseTo(1871 + 90 / 365, 6);
  });

  it('handles leap years', () => {
    const r = parseOhmInterval('1900-03-01', '2000-03-01')!;
    expect(r.from).toBeCloseTo(1900 + 59 / 365, 6); // 1900 is not a leap year
    expect(r.to).toBeCloseTo(2000 + 61 / 366, 6); // 2000 is
  });

  it('parses negative and unpadded years', () => {
    expect(parseOhmInterval('-0027', '-0019')).toEqual({ from: -27, to: -18 });
    expect(parseOhmInterval('999', undefined)).toEqual({ from: 999, to: null });
  });

  it('a missing or empty end date means open-ended', () => {
    expect(parseOhmInterval('1947', undefined)!.to).toBeNull();
    expect(parseOhmInterval('1947', '')!.to).toBeNull();
  });

  it.each([
    ['unparsable start', 'c. 1500', '1600'],
    ['unparsable end', '1500', 'before 1600'],
    ['missing start', undefined, '1600'],
    ['month 13', '1900-13-01', '1901'],
    ['Feb 30', '1900-02-30', '1901'],
    ['end before start (present in the real data)', '1808-05-24', '1807-12-10'],
    ['end equal to start of the same day span is fine only if later', '1900-05-01', '1900-04-30'],
  ])('returns null for %s', (_label, start, end) => {
    expect(parseOhmInterval(start, end)).toBeNull();
  });
});

describe('isShareAlike', () => {
  it.each([
    ['CC-BY-SA-4.0', true],
    ['CC BY-SA 2.0', true],
    ['share-alike', true],
    ['CC0-1.0', false],
    ['CC-BY-4.0', false],
    ['Public domain', false],
    [undefined, false],
  ])('%s -> %s', (license, expected) => {
    expect(isShareAlike(license)).toBe(expected);
  });
});
```
`apps/api/test/resolve-timeline.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { displayPeriod, resolveTimeline, type Interval } from '../src/resolve-timeline';

const iv = (name: string, from: number, to: number | null): Interval => ({ name, color: `c-${name}`, from, to });
const simple = (ps: ReturnType<typeof resolveTimeline>) => ps.map((p) => [p.name, p.from, p.to, p.source]);

describe('resolveTimeline', () => {
  it('OHM beats HB and HB keeps only the parts OHM does not cover (Alsace)', () => {
    const ohm = [iv('German Reich', 1871.34, 1878.53), iv('German Reich', 1878.53, 1890.5), iv('German Reich', 1890.5, 1918.86)];
    const hb = [iv('France', 1815, 1914), iv('German Empire', 1914, 1920), iv('France', 1920, null)];
    expect(simple(resolveTimeline(ohm, hb))).toEqual([
      ['France', 1815, 1871.34, 'hb'],
      ['German Reich', 1871.34, 1918.86, 'ohm'], // three OHM versions merged
      ['German Empire', 1918.86, 1920, 'hb'],
      ['France', 1920, null, 'hb'],
    ]);
  });

  it('keeps HB whole where OHM has no coverage', () => {
    expect(simple(resolveTimeline([], [iv('A', 1000, 1100)]))).toEqual([['A', 1000, 1100, 'hb']]);
  });

  it('drops an HB interval completely covered by OHM', () => {
    expect(simple(resolveTimeline([iv('X', 900, 1200)], [iv('A', 1000, 1100)]))).toEqual([['X', 900, 1200, 'ohm']]);
  });

  it('an open-ended OHM interval hides all later HB', () => {
    expect(simple(resolveTimeline([iv('X', 1500, null)], [iv('A', 1000, null)]))).toEqual([
      ['A', 1000, 1500, 'hb'],
      ['X', 1500, null, 'ohm'],
    ]);
  });

  it('merges same-name intervals separated by less than one year, not by more', () => {
    expect(simple(resolveTimeline([iv('X', 1000, 1010), iv('X', 1010.5, 1020)], []))).toEqual([['X', 1000, 1020, 'ohm']]);
    expect(simple(resolveTimeline([iv('X', 1000, 1010), iv('X', 1012, 1020)], []))).toEqual([
      ['X', 1000, 1010, 'ohm'],
      ['X', 1012, 1020, 'ohm'],
    ]);
  });

  it('merges same-name pieces across sources and marks the merged one as ohm', () => {
    const res = resolveTimeline([iv('France', 1500, 1600)], [iv('France', 1400, 1500)]);
    expect(simple(res)).toEqual([['France', 1400, 1600, 'ohm']]);
  });

  it('sorts by start then name and returns [] for no input', () => {
    expect(resolveTimeline([], [])).toEqual([]);
    expect(resolveTimeline([iv('B', 1000, 1010), iv('A', 1000, 1010)], []).map((p) => p.name)).toEqual(['A', 'B']);
  });
});

describe('displayPeriod', () => {
  it('rounds down; OHM ends inclusively, HB ends at the next snapshot year', () => {
    expect(displayPeriod({ name: 'X', color: 'c', from: 1871.34, to: 1918.86, source: 'ohm' })).toMatchObject({ from: 1871, to: 1918 });
    expect(displayPeriod({ name: 'X', color: 'c', from: 1000, to: 1872, source: 'ohm' })).toMatchObject({ from: 1000, to: 1871 });
    expect(displayPeriod({ name: 'A', color: 'c', from: 1715, to: 1783, source: 'hb' })).toMatchObject({ from: 1715, to: 1783 });
    expect(displayPeriod({ name: 'A', color: 'c', from: 1783, to: null, source: 'hb' })).toMatchObject({ to: null });
  });
});
```
- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run scripts/ohm-dates.test.ts apps/api/test/resolve-timeline.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`scripts/ohm-dates.ts`:
```ts
const DATE_RE = /^(-?\d{1,4})(?:-(\d{2}))?(?:-(\d{2}))?$/;
const CUMULATIVE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInYear = (y: number) => (isLeap(y) ? 366 : 365);
const daysInMonth = (y: number, m: number) =>
  [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const dayOfYear = (y: number, m: number, d: number) =>
  CUMULATIVE[m - 1] + d + (m > 2 && isLeap(y) ? 1 : 0); // 1-based

interface Parts { y: number; m?: number; d?: number }

function parts(s: string | undefined): Parts | null {
  const m = s ? DATE_RE.exec(s.trim()) : null;
  if (!m) return null;
  const y = Number(m[1]);
  const month = m[2] === undefined ? undefined : Number(m[2]);
  const day = m[3] === undefined ? undefined : Number(m[3]);
  if (month !== undefined && (month < 1 || month > 12)) return null;
  if (day !== undefined && month !== undefined && (day < 1 || day > daysInMonth(y, month))) return null;
  return { y, m: month, d: day };
}

// Start of the period the date names, as a decimal year.
function start(s: string | undefined): number | null {
  const p = parts(s);
  if (!p) return null;
  if (p.m === undefined) return p.y;
  return p.y + (dayOfYear(p.y, p.m, p.d ?? 1) - 1) / daysInYear(p.y);
}

// End of the period the date names (exclusive), as a decimal year.
function end(s: string | undefined): number | null {
  const p = parts(s);
  if (!p) return null;
  if (p.m === undefined) return p.y + 1;
  return p.y + dayOfYear(p.y, p.m, p.d ?? daysInMonth(p.y, p.m)) / daysInYear(p.y);
}

export function parseOhmInterval(
  startDate: string | undefined,
  endDate: string | undefined,
): { from: number; to: number | null } | null {
  const from = start(startDate);
  if (from === null) return null;
  if (endDate === undefined || endDate === '') return { from, to: null };
  const to = end(endDate);
  if (to === null || to <= from) return null;
  return { from, to };
}

// Features tagged with a share-alike licence are not imported (see the design spec).
export function isShareAlike(license: string | undefined): boolean {
  return !!license && /(^|[^a-z])sa([^a-z]|$)|share-?alike/i.test(license);
}
```
`apps/api/src/resolve-timeline.ts`:
```ts
export interface Interval { name: string; color: string; from: number; to: number | null }
export interface Period extends Interval { source: 'ohm' | 'hb' }

const MERGE_GAP = 1; // years: same-name intervals closer than this are one period
const endOf = (to: number | null) => to ?? Infinity;

function union(intervals: Interval[]): [number, number][] {
  const sorted = intervals.map((i) => [i.from, endOf(i.to)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = out[out.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

function subtract(i: Interval, holes: [number, number][]): Interval[] {
  const pieces: Interval[] = [];
  const limit = endOf(i.to);
  let cursor = i.from;
  for (const [hFrom, hTo] of holes) {
    if (hTo <= cursor) continue;
    if (hFrom >= limit) break;
    if (hFrom > cursor) pieces.push({ ...i, from: cursor, to: hFrom });
    cursor = Math.max(cursor, hTo);
  }
  if (cursor < limit) pieces.push({ ...i, from: cursor, to: i.to });
  return pieces;
}

export function resolveTimeline(ohm: Interval[], hb: Interval[]): Period[] {
  const holes = union(ohm);
  const all: Period[] = [
    ...ohm.map((i) => ({ ...i, source: 'ohm' as const })),
    ...hb.flatMap((i) => subtract(i, holes)).map((i) => ({ ...i, source: 'hb' as const })),
  ];

  const byName = new Map<string, Period[]>();
  for (const p of all) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);

  const merged: Period[] = [];
  for (const list of byName.values()) {
    list.sort((a, b) => a.from - b.from);
    let cur = { ...list[0] };
    for (const p of list.slice(1)) {
      if (p.from <= endOf(cur.to) + MERGE_GAP) {
        const to = Math.max(endOf(cur.to), endOf(p.to));
        cur = { ...cur, to: to === Infinity ? null : to, source: cur.source === 'ohm' || p.source === 'ohm' ? 'ohm' : 'hb' };
      } else {
        merged.push(cur);
        cur = { ...p };
      }
    }
    merged.push(cur);
  }
  return merged.sort((a, b) => a.from - b.from || a.name.localeCompare(b.name));
}

export function displayPeriod(p: Period) {
  const to = p.to === null ? null : p.source === 'ohm' ? Math.floor(p.to - 1e-6) : Math.floor(p.to);
  return { name: p.name, color: p.color, from: Math.floor(p.from), to, source: p.source };
}
```
- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run scripts/ohm-dates.test.ts apps/api/test/resolve-timeline.test.ts && npm run typecheck`
Expected: all PASS. If a date test fails by a fraction, recompute the expectation from the formula in the comments (day-of-year is 1-based; a start is `(dayOfYear-1)/days`, an end is `dayOfYear/days`); do not loosen `toBeCloseTo` precision below 6 digits.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: OHM date parser and HB/OHM timeline resolver (pure functions)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: OHM import (download, osm2pgsql, staging → final tables)

**Files:**
- Create: `db/fixtures/ohm/staging.sql`, `scripts/import-ohm-lib.ts`, `scripts/import-ohm.ts`, `scripts/fetch-ohm.sh`
- Modify: `docker-compose.yml`, `db/test-support.ts`, `package.json` (script `import:ohm`), `.gitignore` (already ignores `data/`)
- Test: `scripts/import-ohm.test.ts`

**Interfaces:**
- Consumes: `parseOhmInterval`, `isShareAlike` (Task 2); schema (Task 1); `db/ohm.lua` (present; creates `ohm_stage.boundaries(osm_id, tags jsonb, geom)`).
- Produces: `importOhmStaging(pool, opts?: {minYear?: number}): Promise<{imported: number; skippedDate: number; skippedLicense: number; skippedOld: number}>`; `seedOhmFixture(pool)` in test-support (loads `db/fixtures/ohm/staging.sql`); env `OHM_SKIP_LOAD=1` makes the CLI use an existing `ohm_stage` schema.

- [ ] **Step 1: Create the staging fixture**

`db/fixtures/ohm/staging.sql`:
```sql
DROP SCHEMA IF EXISTS ohm_stage CASCADE;
CREATE SCHEMA ohm_stage;
CREATE TABLE ohm_stage.boundaries (
  osm_id bigint PRIMARY KEY,
  tags jsonb NOT NULL,
  geom geometry(MultiPolygon, 4326) NOT NULL
);

INSERT INTO ohm_stage.boundaries (osm_id, tags, geom) VALUES
-- accepted: level 2, name:en preferred over name, overlaps HB "Kingdom A" (lon 0..10)
(1, '{"boundary":"administrative","admin_level":"2","name":"Reich X","name:en":"Realm X","start_date":"1050","end_date":"1080"}',
 ST_Multi(ST_GeomFromText('POLYGON((0 40,10 40,10 50,0 50,0 40))', 4326))),
-- accepted: level 4 region inside Realm X
(2, '{"boundary":"administrative","admin_level":"4","name":"Region R","name:en":"Region R","start_date":"1060","end_date":"1070"}',
 ST_Multi(ST_GeomFromText('POLYGON((0 40,5 40,5 45,0 45,0 40))', 4326))),
-- accepted: CC0 licence, open-ended, outside HB coverage
(3, '{"boundary":"administrative","admin_level":"2","name":"Licensed Land","name:en":"Licensed Land","start_date":"1000","license":"CC0-1.0"}',
 ST_Multi(ST_GeomFromText('POLYGON((30 40,35 40,35 45,30 45,30 40))', 4326))),
-- accepted: no name:en, falls back to name
(4, '{"boundary":"administrative","admin_level":"2","name":"Reich ohne Englisch","start_date":"1200"}',
 ST_Multi(ST_GeomFromText('POLYGON((36 40,40 40,40 45,36 45,36 40))', 4326))),
-- skipped: unparsable date
(5, '{"boundary":"administrative","admin_level":"2","name":"Bad Date Land","name:en":"Bad Date Land","start_date":"c. 1500"}',
 ST_Multi(ST_GeomFromText('POLYGON((20 40,25 40,25 45,20 45,20 40))', 4326))),
-- skipped: end before start (seen in the real data)
(6, '{"boundary":"administrative","admin_level":"2","name":"Reversed Land","name:en":"Reversed Land","start_date":"1300","end_date":"1200"}',
 ST_Multi(ST_GeomFromText('POLYGON((20 40,25 40,25 45,20 45,20 40))', 4326))),
-- skipped: share-alike licence
(7, '{"boundary":"administrative","admin_level":"2","name":"Share Alike Land","name:en":"Share Alike Land","start_date":"1000","license":"CC-BY-SA-4.0"}',
 ST_Multi(ST_GeomFromText('POLYGON((20 40,25 40,25 45,20 45,20 40))', 4326))),
-- filtered out by the Europe bbox (never counted)
(8, '{"boundary":"administrative","admin_level":"2","name":"Far Realm","name:en":"Far Realm","start_date":"1000"}',
 ST_Multi(ST_GeomFromText('POLYGON((100 40,110 40,110 50,100 50,100 40))', 4326)));
```
Add to `db/test-support.ts`:
```ts
export async function seedOhmFixture(pool: pg.Pool): Promise<void> {
  await pool.query(await readFile(path.join(FIXTURE_DIR, 'ohm', 'staging.sql'), 'utf8'));
  await importOhmStaging(pool);
}
```
with imports `import { readFile } from 'node:fs/promises';` and `import { importOhmStaging } from '../scripts/import-ohm-lib';`.

- [ ] **Step 2: Write the failing tests**

`scripts/import-ohm.test.ts`:
```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_DIR, clearAll, seedFixture, testPool } from '../db/test-support';
import { importOhmStaging } from './import-ohm-lib';

const pool = testPool();

beforeEach(async () => {
  await clearAll(pool);
  await seedFixture(pool); // HB rows
  await pool.query(await readFile(path.join(FIXTURE_DIR, 'ohm', 'staging.sql'), 'utf8'));
});
afterAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS ohm_stage CASCADE');
  await pool.end();
});

const ohmRows = () =>
  pool.query(
    `SELECT p.name, p.admin_level, g.valid_from, g.valid_to
     FROM polity_geometries g JOIN polities p ON p.id = g.polity_id
     WHERE g.source = 'ohm' ORDER BY p.name`,
  );

describe('importOhmStaging', () => {
  it('imports valid rows with names, levels and decimal-year intervals, and counts the skipped ones', async () => {
    const result = await importOhmStaging(pool);
    expect(result).toEqual({ imported: 4, skippedDate: 2, skippedLicense: 1, skippedOld: 0 });
    expect((await ohmRows()).rows).toEqual([
      { name: 'Licensed Land', admin_level: 2, valid_from: 1000, valid_to: null },
      { name: 'Realm X', admin_level: 2, valid_from: 1050, valid_to: 1081 }, // name:en wins; end "1080" is end of 1080
      { name: 'Region R', admin_level: 4, valid_from: 1060, valid_to: 1071 },
      { name: 'Reich ohne Englisch', admin_level: 2, valid_from: 1200, valid_to: null }, // falls back to name
    ]);
  });

  it('never imports rows outside the Europe bbox', async () => {
    await importOhmStaging(pool);
    const far = await pool.query("SELECT 1 FROM polities WHERE name = 'Far Realm'");
    expect(far.rowCount).toBe(0);
  });

  it('honours minYear: intervals ending at or before it are dropped and counted', async () => {
    const result = await importOhmStaging(pool, { minYear: 1075 });
    expect(result.skippedOld).toBe(1); // Region R ends 1071
    expect((await ohmRows()).rows.map((r) => r.name)).not.toContain('Region R');
  });

  it('is idempotent and leaves HB rows alone', async () => {
    const hbBefore = await pool.query("SELECT count(*)::int AS n FROM polity_geometries WHERE source = 'hb'");
    await importOhmStaging(pool);
    await importOhmStaging(pool);
    expect((await ohmRows()).rowCount).toBe(4);
    const hbAfter = await pool.query("SELECT count(*)::int AS n FROM polity_geometries WHERE source = 'hb'");
    expect(hbAfter.rows[0].n).toBe(hbBefore.rows[0].n);
  });

  it('stores valid 2D multipolygons', async () => {
    await importOhmStaging(pool);
    const bad = await pool.query(
      "SELECT count(*)::int AS n FROM polity_geometries WHERE source = 'ohm' AND (NOT ST_IsValid(geom) OR ST_NDims(geom) <> 2)",
    );
    expect(bad.rows[0].n).toBe(0);
  });

  it('aborts and changes nothing when the staging table is missing', async () => {
    await importOhmStaging(pool);
    await pool.query('DROP SCHEMA ohm_stage CASCADE');
    await expect(importOhmStaging(pool)).rejects.toThrow();
    expect((await ohmRows()).rowCount).toBe(4);
  });
});
```
Run: `npx vitest run scripts/import-ohm.test.ts` → Expected: FAIL (`Cannot find module './import-ohm-lib'`).

- [ ] **Step 3: Implement the transform**

`scripts/import-ohm-lib.ts`:
```ts
import type pg from 'pg';
import { EUROPE_BBOX } from './import-lib';
import { isShareAlike, parseOhmInterval } from './ohm-dates';

export interface OhmImportResult {
  imported: number;
  skippedDate: number;
  skippedLicense: number;
  skippedOld: number;
}

const INSERT_GEOMETRY = `
WITH g AS (
  SELECT ST_Multi(ST_CollectionExtract(
    ST_Intersection(
      ST_MakeValid(ST_Force2D(geom)),
      ST_MakeEnvelope(-180, -85, 180, 85, 4326)),
    3)) AS geom
  FROM ohm_stage.boundaries WHERE osm_id = $1
), keep AS (
  SELECT geom FROM g WHERE NOT ST_IsEmpty(geom)
), p AS (
  INSERT INTO polities (name, admin_level)
  SELECT $2::text, $3::smallint FROM keep
  ON CONFLICT (name, admin_level) DO UPDATE SET name = EXCLUDED.name
  RETURNING id
)
INSERT INTO polity_geometries (polity_id, source, valid_from, valid_to, geom)
SELECT p.id, 'ohm', $4::float8, $5::float8, keep.geom FROM p, keep`;

// Transforms ohm_stage.boundaries (loaded by osm2pgsql, see db/ohm.lua) into the final tables.
// Reloads only source='ohm', in one transaction.
export async function importOhmStaging(
  pool: pg.Pool,
  opts: { minYear?: number } = {},
): Promise<OhmImportResult> {
  const minYear = opts.minYear ?? 1;
  if (!Number.isFinite(minYear)) throw new Error(`Invalid minYear: ${opts.minYear}`);

  const { rows } = await pool.query(
    `SELECT osm_id::text AS osm_id, tags->>'admin_level' AS level, tags->>'name:en' AS name_en,
            tags->>'name' AS name, tags->>'start_date' AS start_date, tags->>'end_date' AS end_date,
            tags->>'license' AS license
     FROM ohm_stage.boundaries
     WHERE ST_Intersects(geom, ST_MakeEnvelope($1::float8, $2::float8, $3::float8, $4::float8, 4326))
     ORDER BY osm_id`,
    [EUROPE_BBOX.west, EUROPE_BBOX.south, EUROPE_BBOX.east, EUROPE_BBOX.north],
  );

  const result: OhmImportResult = { imported: 0, skippedDate: 0, skippedLicense: 0, skippedOld: 0 };
  const accepted: { id: string; name: string; level: number; from: number; to: number | null }[] = [];
  for (const r of rows) {
    if (isShareAlike(r.license)) { result.skippedLicense++; continue; }
    const interval = parseOhmInterval(r.start_date ?? undefined, r.end_date ?? undefined);
    if (!interval) { result.skippedDate++; continue; }
    if (interval.to !== null && interval.to <= minYear) { result.skippedOld++; continue; }
    const name = r.name_en ?? r.name;
    if (!name) { result.skippedDate++; continue; }
    accepted.push({ id: r.osm_id, name, level: Number(r.level), ...interval });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM polity_geometries WHERE source = 'ohm'");
    for (const a of accepted) {
      const res = await client.query(INSERT_GEOMETRY, [a.id, a.name, a.level, a.from, a.to]);
      result.imported += res.rowCount ?? 0;
    }
    await client.query(
      'DELETE FROM polities p WHERE NOT EXISTS (SELECT 1 FROM polity_geometries g WHERE g.polity_id = p.id)',
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return result;
}
```
(A relation with no name at all is counted under `skippedDate` to keep the result shape fixed; note it in the report message of the CLI as "skipped (bad date / no name)".)

Run: `npx vitest run scripts/import-ohm.test.ts` → Expected: 6 PASS. The `skippedDate` count of 2 covers ids 5 and 6.

- [ ] **Step 4: Compose service, download script and CLI**

Append to `docker-compose.yml` under `services:`:
```yaml
  osm2pgsql:
    image: iboates/osm2pgsql:2.3.1
    profiles: ["tools"]
    environment:
      PGPASSWORD: postgres
    volumes:
      - ./data/ohm:/data
      - ./db:/db:ro
    depends_on:
      db: { condition: service_healthy }
```
`scripts/fetch-ohm.sh` (`chmod +x`):
```bash
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
```
`scripts/import-ohm.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import pg from 'pg';
import { applySchema } from '../db/apply-schema';
import { importOhmStaging } from './import-ohm-lib';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/historicalmap';
const minYear = process.env.MIN_YEAR ? Number(process.env.MIN_YEAR) : undefined;
const skipLoad = process.env.OHM_SKIP_LOAD === '1'; // use an existing ohm_stage schema (tests/e2e)

const pool = new pg.Pool({ connectionString: url });
try {
  await applySchema(pool);
  if (!skipLoad) {
    execFileSync('scripts/fetch-ohm.sh', { stdio: 'inherit' });
    await pool.query('DROP SCHEMA IF EXISTS ohm_stage CASCADE; CREATE SCHEMA ohm_stage;');
    // No --bbox: it cuts relation members outside the box and breaks ring assembly.
    execFileSync(
      'docker',
      ['compose', '--profile', 'tools', 'run', '--rm', 'osm2pgsql', 'osm2pgsql',
        '-H', 'db', '-U', 'postgres', '-d', 'historicalmap',
        '--slim', '--flat-nodes', '/data/nodes.bin',
        '--schema=ohm_stage', '--middle-schema=ohm_stage', '--log-progress=false',
        '-O', 'flex', '-S', '/db/ohm.lua', '/data/planet.osm.pbf'],
      { stdio: 'inherit' },
    );
  }
  const r = await importOhmStaging(pool, { minYear });
  console.log(
    `OHM: imported ${r.imported}, skipped ${r.skippedDate} (bad date / no name), ${r.skippedLicense} (share-alike licence), ${r.skippedOld} (before MIN_YEAR)`,
  );
  await pool.query('DROP SCHEMA IF EXISTS ohm_stage CASCADE');
  if (!skipLoad) rmSync('data/ohm/nodes.bin', { force: true });
} finally {
  await pool.end();
}
```
Add to `package.json` scripts: `"import:ohm": "tsx scripts/import-ohm.ts"`.

- [ ] **Step 5: Manual smoke on the real planet dump (record the result)**

```bash
docker compose up -d --wait db
npm run import && npm run import:ohm     # ~10 minutes; the dump is ~1.3 GB
docker compose exec -T db psql -U postgres -d historicalmap -c "
SELECT p.name, g.source, g.valid_from::numeric(8,2), g.valid_to::numeric(8,2)
FROM polity_geometries g JOIN polities p ON p.id=g.polity_id
WHERE p.admin_level=2 AND ST_Intersects(g.geom, ST_SetSRID(ST_MakePoint(7.36,48.08),4326))
  AND g.valid_from BETWEEN 1800 AND 1950 ORDER BY g.valid_from"
```
Expected: the CLI prints an OHM report with imported in the low thousands and non-zero `skipped (bad date / no name)`; Colmar rows include OHM `German Reich` from 1871.34 to 1918.86 (three consecutive OHM rows) next to HB rows. Record the report line in the ledger. If `osm2pgsql` fails, do not add `--bbox`; check `docker compose run` output first.

- [ ] **Step 6: Full suite and commit**

Run: `npx vitest run && npm run typecheck` → Expected: all pass.
```bash
git add -A && git commit -m "feat: import OHM boundaries from the planet dump via osm2pgsql

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: API — range, precedence, timeline, history levels

**Files:**
- Modify: `apps/api/src/app.ts` (full replacement below), `apps/api/test/app.test.ts` (full replacement below)
- Delete: `apps/api/src/timeline.ts`, `apps/api/test/timeline.test.ts` (superseded by `resolve-timeline`)

**Interfaces:**
- Consumes: `resolveTimeline`, `displayPeriod`, `Interval`, `Period` (Task 2); schema and `seedOhmFixture` (Tasks 1, 3).
- Produces: `GET /range` → `{min: number|null, max: number|null}`; `GET /at` → `{year, polities: {id,name,adminLevel,source,borderPrecision,color}[], regions: same[]}`; `GET /timeline` → `{periods: {name,color,from,to,source}[]}`; `GET /history?lat&lon&levels=2,3,4` → GeoJSON `FeatureCollection` with properties `{name,color,level,source,from,to,periods:[{from,to}]}`.

- [ ] **Step 1: Replace the API tests (RED)**

`apps/api/test/app.test.ts` (whole file):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearAll, seedFixture, seedOhmFixture, testPool } from '../../../db/test-support';
import { createApp } from '../src/app';

const pool = testPool();
const app = createApp(pool);
const thisYear = new Date().getFullYear();

const get = (url: string) => app.inject({ method: 'GET', url });
const names = (body: string, key = 'polities') =>
  JSON.parse(body)[key].map((p: { name: string }) => p.name).sort();

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('HB data only', () => {
  beforeAll(async () => {
    await clearAll(pool);
    await seedFixture(pool);
  });

  it('GET /range spans the earliest interval to the current year', async () => {
    expect((await get('/range')).json()).toEqual({ min: 1000, max: thisYear });
  });

  describe('GET /at', () => {
    it('returns the polity at a point, marked as HB', async () => {
      const res = await get('/at?lat=45&lon=2&year=1000');
      expect(res.statusCode).toBe(200);
      expect(res.json().year).toBe(1000);
      expect(res.json().polities).toEqual([
        expect.objectContaining({ name: 'Kingdom A', adminLevel: 2, source: 'hb' }),
      ]);
      expect(res.json().regions).toEqual([]);
    });

    it('returns every overlapping polity', async () => {
      expect(names((await get('/at?lat=45&lon=7&year=1000')).body)).toEqual(['Kingdom A', 'Kingdom B']);
    });

    it('a year between two HB snapshots uses the earlier snapshot', async () => {
      expect(names((await get('/at?lat=45&lon=7&year=1050')).body)).toEqual(['Kingdom A', 'Kingdom B']);
    });

    it('the last HB snapshot stays valid up to the present', async () => {
      expect(names((await get(`/at?lat=45&lon=8&year=${thisYear}`)).body)).toEqual(['Kingdom B']);
    });

    it('reports a polity once even if it has several features at the point', async () => {
      expect(names((await get('/at?lat=45&lon=8&year=1100')).body)).toEqual(['Kingdom B']);
    });

    it('returns 200 with an empty list for a point with no data', async () => {
      const res = await get('/at?lat=0&lon=-30&year=1000');
      expect(res.statusCode).toBe(200);
      expect(res.json().polities).toEqual([]);
    });

    it.each([
      ['lat too big', '/at?lat=91&lon=0&year=1000'],
      ['lon too big', '/at?lat=0&lon=190&year=1000'],
      ['missing year', '/at?lat=0&lon=0'],
      ['non-numeric lat', '/at?lat=abc&lon=0&year=1000'],
      ['year before the first interval', '/at?lat=45&lon=2&year=999'],
      ['year after the current year', `/at?lat=45&lon=2&year=${thisYear + 1}`],
    ])('rejects %s with 400', async (_l, url) => {
      expect((await get(url)).statusCode).toBe(400);
    });
  });

  describe('GET /timeline', () => {
    it('builds the timeline of a point from HB intervals', async () => {
      expect((await get('/timeline?lat=45&lon=7')).json().periods).toEqual([
        { name: 'Kingdom A', color: expect.stringMatching(/^hsl/), from: 1000, to: 1100, source: 'hb' },
        { name: 'Kingdom B', color: expect.stringMatching(/^hsl/), from: 1000, to: null, source: 'hb' },
      ]);
    });

    it('includes unnamed territory as its own period', async () => {
      expect((await get('/timeline?lat=42&lon=22')).json().periods).toEqual([
        { name: 'Unnamed territory', color: 'hsl(0, 0%, 80%)', from: 1000, to: 1100, source: 'hb' },
      ]);
    });

    it('returns 200 with no periods for the sea and 400 for bad coordinates', async () => {
      expect((await get('/timeline?lat=0&lon=-30')).json().periods).toEqual([]);
      expect((await get('/timeline?lat=45&lon=181')).statusCode).toBe(400);
    });
  });

  describe('GET /history', () => {
    it('returns one contour per polity that ever held the point, with its span', async () => {
      const res = await get('/history?lat=45&lon=7');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.type).toBe('FeatureCollection');
      expect(body.features.map((f: { properties: unknown }) => f.properties)).toEqual([
        { name: 'Kingdom A', color: expect.stringMatching(/^hsl/), level: 2, source: 'hb', from: 1000, to: 1100, periods: [{ from: 1000, to: 1100 }] },
        { name: 'Kingdom B', color: expect.stringMatching(/^hsl/), level: 2, source: 'hb', from: 1000, to: null, periods: [{ from: 1000, to: null }] },
      ]);
      for (const f of body.features) expect(['Polygon', 'MultiPolygon']).toContain(f.geometry.type);
    });

    it("unions a polity's several features into a single contour", async () => {
      const res = await get('/history?lat=45&lon=8');
      const b = res.json().features.filter((f: { properties: { name: string } }) => f.properties.name === 'Kingdom B');
      expect(b).toHaveLength(1);
    });

    it('contour covers the whole polity, not just the clicked spot', async () => {
      const a = (await get('/history?lat=45&lon=2')).json().features[0];
      const lons = (JSON.stringify(a.geometry.coordinates).match(/-?\d+(\.\d+)?/g) ?? [])
        .filter((_: string, i: number) => i % 2 === 0).map(Number);
      expect(Math.min(...lons)).toBe(0);
      expect(Math.max(...lons)).toBe(10);
    });

    it('returns 200 with no features for the sea; rejects bad coordinates and bad levels', async () => {
      expect((await get('/history?lat=0&lon=-30')).json()).toEqual({ type: 'FeatureCollection', features: [] });
      expect((await get('/history?lat=45&lon=181')).statusCode).toBe(400);
      expect((await get('/history?lat=95&lon=0')).statusCode).toBe(400);
      expect((await get('/history?lat=45&lon=7&levels=5')).statusCode).toBe(400);
    });
  });

  it('empty database: /range is null, /at is 400', async () => {
    await clearAll(pool);
    expect((await get('/range')).json()).toEqual({ min: null, max: null });
    expect((await get('/at?lat=45&lon=2&year=1000')).statusCode).toBe(400);
    await seedFixture(pool);
  });
});

describe('HB + OHM data', () => {
  beforeAll(async () => {
    await clearAll(pool);
    await seedFixture(pool);
    await seedOhmFixture(pool);
  });
  afterAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS ohm_stage CASCADE');
    await clearAll(pool);
    await seedFixture(pool);
  });

  describe('GET /at', () => {
    it('OHM wins over HB and reports the regions of the state', async () => {
      const res = await get('/at?lat=44&lon=2&year=1060');
      expect(res.json().polities).toEqual([
        expect.objectContaining({ name: 'Realm X', adminLevel: 2, source: 'ohm' }),
      ]);
      expect(res.json().regions).toEqual([
        expect.objectContaining({ name: 'Region R', adminLevel: 4, source: 'ohm' }),
      ]);
    });

    it('HB fills the years before and after OHM coverage', async () => {
      expect((await get('/at?lat=44&lon=2&year=1000')).json().polities).toEqual([
        expect.objectContaining({ name: 'Kingdom A', source: 'hb' }),
      ]);
      expect((await get('/at?lat=44&lon=2&year=1090')).json().polities).toEqual([
        expect.objectContaining({ name: 'Kingdom A', source: 'hb' }),
      ]);
    });

    it('regions are only those that contain the point', async () => {
      const res = await get('/at?lat=44&lon=7&year=1060');
      expect(names(res.body)).toEqual(['Realm X']);
      expect(res.json().regions).toEqual([]);
    });

    it('OHM-only place', async () => {
      expect(names((await get('/at?lat=42&lon=32&year=1500')).body)).toEqual(['Licensed Land']);
    });
  });

  describe('GET /timeline', () => {
    it('OHM interval splits the HB interval it overrides', async () => {
      expect((await get('/timeline?lat=44&lon=2')).json().periods).toEqual([
        { name: 'Kingdom A', color: expect.stringMatching(/^hsl/), from: 1000, to: 1050, source: 'hb' },
        { name: 'Realm X', color: expect.stringMatching(/^hsl/), from: 1050, to: 1080, source: 'ohm' },
        { name: 'Kingdom A', color: expect.stringMatching(/^hsl/), from: 1081, to: 1100, source: 'hb' },
        { name: 'Kingdom B', color: expect.stringMatching(/^hsl/), from: 1100, to: null, source: 'hb' },
      ]);
    });

    it('OHM-only place has an open-ended OHM period', async () => {
      expect((await get('/timeline?lat=42&lon=32')).json().periods).toEqual([
        { name: 'Licensed Land', color: expect.stringMatching(/^hsl/), from: 1000, to: null, source: 'ohm' },
      ]);
    });
  });

  describe('GET /history', () => {
    it('defaults to level 2 and resolves HB against OHM', async () => {
      const features = (await get('/history?lat=44&lon=2')).json().features;
      expect(features.map((f: { properties: { name: string } }) => f.properties.name)).toEqual([
        'Kingdom A', 'Realm X', 'Kingdom B',
      ]);
      expect(features[0].properties).toMatchObject({
        source: 'hb', from: 1000, to: 1100, periods: [{ from: 1000, to: 1050 }, { from: 1081, to: 1100 }],
      });
      expect(features[1].properties).toMatchObject({ source: 'ohm', level: 2, from: 1050, to: 1080 });
    });

    it('levels=2,3,4 adds the regions', async () => {
      const features = (await get('/history?lat=44&lon=2&levels=2,3,4')).json().features;
      expect(features.map((f: { properties: { name: string } }) => f.properties.name)).toEqual([
        'Kingdom A', 'Realm X', 'Region R', 'Kingdom B',
      ]);
      expect(features[2].properties).toMatchObject({ level: 4, source: 'ohm', from: 1060, to: 1070 });
    });
  });
});
```
Run: `git rm apps/api/src/timeline.ts apps/api/test/timeline.test.ts` then `npx vitest run apps/api` → Expected: FAIL (`/range` 404, missing fields).

- [ ] **Step 2: Replace `apps/api/src/app.ts`**

```ts
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { displayPeriod, resolveTimeline, type Interval } from './resolve-timeline';

const pointSchema = {
  lat: { type: 'number', minimum: -90, maximum: 90 },
  lon: { type: 'number', minimum: -180, maximum: 180 },
} as const;

const atSchema = {
  querystring: {
    type: 'object',
    required: ['lat', 'lon', 'year'],
    properties: { ...pointSchema, year: { type: 'integer' } },
  },
} as const;

const timelineSchema = {
  querystring: { type: 'object', required: ['lat', 'lon'], properties: pointSchema },
} as const;

const historySchema = {
  querystring: {
    type: 'object',
    required: ['lat', 'lon'],
    properties: { ...pointSchema, levels: { type: 'string', pattern: '^[2-4](,[2-4])*$' } },
  },
} as const;

const POINT = 'ST_SetSRID(ST_MakePoint($1, $2), 4326)';
const VALID_AT = 'g.valid_from <= $3 AND (g.valid_to IS NULL OR g.valid_to > $3)';
const BASE = 'FROM polity_geometries g JOIN polities p ON p.id = g.polity_id';

interface IntervalRow { name: string; color: string; source: 'ohm' | 'hb'; valid_from: number; valid_to: number | null }
const intervals = (rows: IntervalRow[], source: 'ohm' | 'hb'): Interval[] =>
  rows.filter((r) => r.source === source).map((r) => ({ name: r.name, color: r.color, from: r.valid_from, to: r.valid_to }));

export function createApp(pool: pg.Pool): FastifyInstance {
  const app = Fastify();
  app.register(cors, { origin: true });

  const range = async (): Promise<{ min: number | null; max: number | null }> => {
    const { rows } = await pool.query('SELECT floor(min(valid_from))::int AS min FROM polity_geometries');
    const min = rows[0].min as number | null;
    return min === null ? { min: null, max: null } : { min, max: new Date().getFullYear() };
  };

  app.get('/range', async () => range());

  app.get('/at', { schema: atSchema }, async (req, reply) => {
    const { lat, lon, year } = req.query as { lat: number; lon: number; year: number };
    const r = await range();
    if (r.min === null || year < r.min || year > (r.max as number)) {
      return reply.code(400).send({ error: 'year out of range', min: r.min, max: r.max });
    }
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (p.id, g.source) p.id, p.name, p.admin_level AS "adminLevel", g.source,
              g.border_precision AS "borderPrecision", polity_color(p.name) AS color
       ${BASE}
       WHERE ${VALID_AT} AND ST_Intersects(g.geom, ${POINT})
       ORDER BY p.id, g.source, g.border_precision DESC NULLS LAST`,
      [lon, lat, year + 0.5],
    );
    const states = (source: string) => rows.filter((x) => x.source === source && x.adminLevel === 2);
    const ohmStates = states('ohm');
    const polities = ohmStates.length > 0 ? ohmStates : states('hb'); // OHM wins, HB fills the gap
    const regions = rows
      .filter((x) => x.source === 'ohm' && x.adminLevel > 2)
      .sort((a, b) => a.adminLevel - b.adminLevel || a.name.localeCompare(b.name));
    return { year, polities, regions };
  });

  app.get('/timeline', { schema: timelineSchema }, async (req) => {
    const { lat, lon } = req.query as { lat: number; lon: number };
    const { rows } = await pool.query(
      `SELECT p.name, polity_color(p.name) AS color, g.source, g.valid_from, g.valid_to
       ${BASE}
       WHERE p.admin_level = 2 AND ST_Intersects(g.geom, ${POINT})`,
      [lon, lat],
    );
    return { periods: resolveTimeline(intervals(rows, 'ohm'), intervals(rows, 'hb')).map(displayPeriod) };
  });

  // One contour per polity that ever held the point: the union of its geometries containing the
  // point, simplified to keep the payload small. HB polities count only if some interval survives
  // OHM precedence.
  app.get('/history', { schema: historySchema }, async (req) => {
    const { lat, lon, levels } = req.query as { lat: number; lon: number; levels?: string };
    const wanted = (levels ?? '2').split(',').map(Number);
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.admin_level AS level, polity_color(p.name) AS color,
              g.source, g.valid_from, g.valid_to
       ${BASE}
       WHERE p.admin_level = ANY($3::int[]) AND ST_Intersects(g.geom, ${POINT})`,
      [lon, lat, wanted],
    );

    type Row = IntervalRow & { id: number; level: number };
    const all = rows as Row[];
    const entries: { id: number; level: number; periods: ReturnType<typeof resolveTimeline> }[] = [];

    const stateRows = all.filter((r) => r.level === 2);
    for (const period of resolveTimeline(intervals(stateRows, 'ohm'), intervals(stateRows, 'hb'))) {
      const id = stateRows.find((r) => r.name === period.name)!.id;
      const existing = entries.find((e) => e.id === id);
      if (existing) existing.periods.push(period);
      else entries.push({ id, level: 2, periods: [period] });
    }
    const regionIds = [...new Set(all.filter((r) => r.level > 2).map((r) => r.id))];
    for (const id of regionIds) {
      const own = all.filter((r) => r.id === id);
      entries.push({ id, level: own[0].level, periods: resolveTimeline(intervals(own, 'ohm'), []) });
    }
    if (entries.length === 0) return { type: 'FeatureCollection' as const, features: [] };

    const geo = await pool.query(
      `SELECT p.id, ST_AsGeoJSON(ST_SimplifyPreserveTopology(ST_Union(g.geom), 0.02))::json AS geometry
       ${BASE}
       WHERE p.id = ANY($3::int[]) AND ST_Intersects(g.geom, ${POINT})
       GROUP BY p.id`,
      [lon, lat, entries.map((e) => e.id)],
    );
    const geometry = new Map(geo.rows.map((r) => [r.id as number, r.geometry]));

    const features = entries.map((e) => {
      const display = e.periods.map(displayPeriod);
      const first = all.find((r) => r.id === e.id)!;
      return {
        type: 'Feature' as const,
        properties: {
          name: first.name,
          color: first.color,
          level: e.level,
          source: e.periods.some((p) => p.source === 'ohm') ? ('ohm' as const) : ('hb' as const),
          from: display[0].from,
          to: display[display.length - 1].to,
          periods: display.map(({ from, to }) => ({ from, to })),
        },
        geometry: geometry.get(e.id),
      };
    });
    features.sort((a, b) => a.properties.from - b.properties.from || a.properties.name.localeCompare(b.properties.name));
    return { type: 'FeatureCollection' as const, features };
  });

  return app;
}
```
- [ ] **Step 3: Run to verify GREEN**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS. If `/history` ordering differs, the sort is by `from` then `name` (Kingdom A 1000, Realm X 1050, Region R 1060, Kingdom B 1100). The expected `periods` for Kingdom A come from HB `[1000,1100)` minus OHM `[1050,1081)`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: API with OHM precedence, /range, regions and history levels

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Three-layer tiles

**Files:**
- Modify: `db/02-functions.sql`, `db/tile.test.ts`

**Interfaces:**
- Consumes: schema and `seedOhmFixture` (Tasks 1, 3).
- Produces: `polity_tile_layer(layer text, src text, min_level int, max_level int, at_time double precision, bounds geometry) -> bytea`; `polities_tile` returns `fallback` (HB) + `polities` (OHM level 2) + `regions` (OHM levels 3-4) layers, each feature with `id, name, color, level, border_precision`.

- [ ] **Step 1: Update the tile tests (RED)**

In `db/tile.test.ts`: import `seedOhmFixture`; change `beforeAll` to
```ts
beforeAll(async () => {
  await clearAll(pool);
  await seedFixture(pool);
  await seedOhmFixture(pool);
});
afterAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS ohm_stage CASCADE');
  await pool.end();
});
```
Replace `decode` and the `polities_tile` describe with:
```ts
function decode(buf: Buffer, layerName: string) {
  const layer = new VectorTile(new PbfReader(buf)).layers[layerName];
  if (!layer) return [];
  return Array.from({ length: layer.length }, (_, i) => layer.feature(i).properties);
}
const namesIn = (buf: Buffer, layer: string) => decode(buf, layer).map((f) => f.name).sort();

describe('polities_tile', () => {
  it('fallback holds HB, polities holds OHM level 2, regions holds OHM levels 3-4', async () => {
    const t = await tile(0, 0, 0, { year: '1060' });
    expect(namesIn(t, 'fallback')).toEqual(['Kingdom A', 'Kingdom B', 'Unnamed territory']);
    expect(namesIn(t, 'polities')).toEqual(['Licensed Land', 'Realm X']);
    expect(namesIn(t, 'regions')).toEqual(['Region R']);
  });

  it('follows the year: OHM features appear and disappear at their dates', async () => {
    expect(namesIn(await tile(0, 0, 0, { year: '1000' }), 'polities')).toEqual(['Licensed Land']);
    const later = await tile(0, 0, 0, { year: '1500' });
    expect(namesIn(later, 'polities')).toEqual(['Licensed Land', 'Reich ohne Englisch']);
    expect(namesIn(later, 'regions')).toEqual([]);
    expect(namesIn(later, 'fallback')).toEqual(['Kingdom B', 'Kingdom B']);
  });

  it('exposes id, name, color, level and border_precision', async () => {
    const t = await tile(0, 0, 0, { year: '1060' });
    const a = decode(t, 'fallback').find((f) => f.name === 'Kingdom A');
    expect(a).toMatchObject({ name: 'Kingdom A', level: 2, border_precision: 2 });
    expect(a?.color).toMatch(/^hsl\(/);
    expect(decode(t, 'regions')[0]).toMatchObject({ name: 'Region R', level: 4 });
  });

  it('returns an empty tile where there is no data', async () => {
    expect((await tile(4, 0, 0, { year: '1000' })).length).toBe(0);
  });

  it.each([
    ['missing year', {}],
    ['non-numeric year', { year: 'abc' }],
    ['year before any data', { year: '999' }],
  ])('returns an empty tile for %s, not an error', async (_label, params) => {
    expect((await tile(0, 0, 0, params)).length).toBe(0);
  });
});
```
Keep the `polity_color` describe. Run: `npx vitest run db/tile.test.ts` → Expected: FAIL (layers missing).

- [ ] **Step 2: Implement the layered tile function**

In `db/02-functions.sql` replace `polities_tile` with:
```sql
-- One MVT layer from polity_geometries rows of a source and admin-level range valid at a time.
CREATE OR REPLACE FUNCTION polity_tile_layer(
  layer text, src text, min_level integer, max_level integer,
  at_time double precision, bounds geometry)
RETURNS bytea LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(ST_AsMVT(t, layer, 4096, 'geom'), ''::bytea)
  FROM (
    SELECT p.id, p.name, polity_color(p.name) AS color, p.admin_level AS level, g.border_precision,
           ST_AsMVTGeom(ST_Transform(g.geom, 3857), bounds, 4096, 64, true) AS geom
    FROM polity_geometries g
    JOIN polities p ON p.id = g.polity_id
    WHERE g.source = src
      AND p.admin_level BETWEEN min_level AND max_level
      AND g.valid_from <= at_time AND (g.valid_to IS NULL OR g.valid_to > at_time)
      AND g.geom && ST_Transform(bounds, 4326)
  ) t
  WHERE t.geom IS NOT NULL
$$;

-- Martin function source. `fallback` (HB) is drawn under `polities` (OHM level 2); `regions` are OHM levels 3-4.
CREATE OR REPLACE FUNCTION polities_tile(z integer, x integer, y integer, query_params json DEFAULT '{}')
RETURNS bytea LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  year_text text := query_params->>'year';
  at_time double precision;
  bounds geometry := ST_TileEnvelope(z, x, y);
BEGIN
  IF year_text IS NULL OR year_text !~ '^-?[0-9]{1,6}$' THEN
    RETURN ''::bytea;
  END IF;
  at_time := year_text::integer + 0.5;
  RETURN polity_tile_layer('fallback', 'hb', 2, 2, at_time, bounds)
      || polity_tile_layer('polities', 'ohm', 2, 2, at_time, bounds)
      || polity_tile_layer('regions', 'ohm', 3, 4, at_time, bounds);
END
$$;
```
- [ ] **Step 3: Run to verify GREEN, then verify with Martin**

Run: `npx vitest run db/tile.test.ts` → Expected: all PASS (concatenated MVT layers decode as separate layers).
Then verify Martin discovers the function after the schema was re-applied (the import CLI does that): `docker compose up -d --wait db martin && docker compose restart martin && curl -s localhost:3100/catalog | head -c 300` and `curl -s -o /dev/null -w '%{http_code} %{size_download}\n' 'localhost:3100/polities_tile/3/4/2?year=1900'`. Expected: catalog lists `polities_tile`; tile returns `200` with a non-zero size (real data loaded in Task 3 Step 5; if the database only has HB data the size is still non-zero).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: three-layer tiles (fallback, polities, regions)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: UI — year input, regions, approximate markers

**Files:**
- Modify: `apps/web/src/{api,format,panel,pin-mode,main,strings}.ts`, `apps/web/index.html`, `apps/web/src/style.css`, `apps/web/e2e/smoke.spec.ts`, `.github/workflows/ci.yml`
- Test: `apps/web/src/format.test.ts`, `apps/web/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: API contracts from Task 4; tile layers from Task 5.
- Produces: `clampYear(raw: string, min: number, max: number, fallback: number): number` in `format.ts`.

- [ ] **Step 1: Failing unit test for `clampYear`**

Append to `apps/web/src/format.test.ts` (and add `clampYear` to the import):
```ts
describe('clampYear', () => {
  it('parses, truncates and clamps to the range', () => {
    expect(clampYear('1871', 1000, 2026, 2026)).toBe(1871);
    expect(clampYear('1871.9', 1000, 2026, 2026)).toBe(1871);
    expect(clampYear('5', 1000, 2026, 2026)).toBe(1000);
    expect(clampYear('9999', 1000, 2026, 2026)).toBe(2026);
  });
  it('keeps the fallback for non-numeric input', () => {
    expect(clampYear('', 1000, 2026, 1500)).toBe(1500);
    expect(clampYear('abc', 1000, 2026, 1500)).toBe(1500);
  });
});
```
Run `npm test -w apps/web` → FAIL. Implement in `format.ts`:
```ts
export function clampYear(raw: string, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(raw));
  if (raw.trim() === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
```
Run again → PASS.

- [ ] **Step 2: Types, strings, HTML, CSS**

`apps/web/src/strings.ts` add: `approximate: '(approximate)', regions: 'Regions', regionsHeading: 'Regions', yearInput: 'Year',`.
`apps/web/src/api.ts` replace the interfaces and fetchers:
```ts
export interface PolityAt {
  id: number; name: string; adminLevel: number; source: 'ohm' | 'hb';
  borderPrecision: number | null; color: string;
}
export interface AtResponse { year: number; polities: PolityAt[]; regions: PolityAt[] }
export interface Period { name: string; color: string; from: number; to: number | null; source: 'ohm' | 'hb' }
export interface HistoryProperties {
  name: string; color: string; level: number; source: 'ohm' | 'hb';
  from: number; to: number | null; periods: { from: number; to: number | null }[];
}
// HistoryFeature / HistoryCollection unchanged

export const fetchRange = () => getJson<{ min: number | null; max: number | null }>('/range');
export const fetchHistory = (lat: number, lon: number, withRegions: boolean) =>
  getJson<HistoryCollection>(`/history?lat=${lat}&lon=${lon}${withRegions ? '&levels=2,3,4' : ''}`);
```
(delete `fetchSnapshots`; keep `fetchAt` and `fetchTimeline`).
`apps/web/index.html`: replace the `#controls` footer content:
```html
    <footer id="controls">
      <label for="slider">Year:</label>
      <input id="slider" type="range" min="0" max="0" step="1" value="0" />
      <input id="year-input" type="number" aria-label="Year" step="1" />
      <label class="regions-toggle"><input id="regions" type="checkbox" /> Regions</label>
      <strong id="year-label"></strong>
    </footer>
```
`#year-label` shows the current year (and status or error messages); the e2e tests read it. CSS additions:
```css
#year-input { width: 5.5em; }
.regions-toggle { white-space: nowrap; font-size: .9rem; }
#panel li.indent { margin-left: 16px; }
.approx { color: #666; font-size: .8rem; }
```

- [ ] **Step 3: Panel and pin layer**

`apps/web/src/panel.ts`: change `renderPanel(el, at, periods, showRegions)`: replace the `snapshotYear` note block by nothing; list entries via
```ts
function polityItem(p: PolityAt, indent: boolean): HTMLLIElement {
  const li = item(p.color, polityLabel(p.name));
  if (indent) li.classList.add('indent');
  if (p.source === 'hb') {
    const note = document.createElement('span');
    note.className = 'approx';
    note.textContent = t.approximate;
    li.append(note);
  }
  return li;
}
```
State list: `for (const p of at.polities) ul.append(polityItem(p, false))`; when `showRegions`, `for (const r of at.regions) ul.append(polityItem(r, true))`. Timeline items get `t.approximate` appended the same way when `p.source === 'hb'`. `renderHistoryPanel` items: add class `indent` when `f.properties.level > 2` and the `approx` note when `source === 'hb'`; import `PolityAt`.
`apps/web/src/pin-mode.ts`: replace the `history-fill` and `history-line` paints with level-aware ones:
```ts
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['==', ['get', 'level'], 2], 0.15, 0.06] },
    ...
    paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['==', ['get', 'level'], 2], 1.5, 0.8] },
```

- [ ] **Step 4: main.ts**

Replace the top part and handlers in `apps/web/src/main.ts` (keep the imports of MapLibre/CSS/panel/pin-mode, add `fetchRange` and `clampYear`, drop `fetchSnapshots`):
```ts
const yearInput = document.getElementById('year-input') as HTMLInputElement;
const regionsBox = document.getElementById('regions') as HTMLInputElement;

let range: { min: number | null; max: number | null };
try {
  range = await fetchRange();
} catch {
  yearLabel.textContent = t.serverUnreachable;
  throw new Error('API unavailable');
}
if (range.min === null || range.max === null) {
  yearLabel.textContent = t.noImportedData;
  throw new Error('No data in the database');
}
const { min, max } = { min: range.min, max: range.max };

let year = max;
slider.min = yearInput.min = String(min);
slider.max = yearInput.max = String(max);
const showYear = () => {
  slider.value = yearInput.value = String(year);
  yearLabel.textContent = formatYear(year);
};
showYear();
```
Style: replace the single vector source layers with the three source-layers:
```ts
const fillLayers = [
  { id: 'fallback-fill', layer: 'fallback', opacity: 0.55 },
  { id: 'polity-fill', layer: 'polities', opacity: 1 },
] as const;
...
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': '#bcd7e6' } },
      ...fillLayers.map((l) => ({
        id: l.id, type: 'fill' as const, source, 'source-layer': l.layer,
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': l.opacity },
      })),
      ...['fallback', 'polities'].flatMap((layer) => [
        { id: `${layer}-line-precise`, type: 'line' as const, source, 'source-layer': layer,
          filter: ['!=', ['get', 'border_precision'], 1],
          paint: { 'line-color': '#444', 'line-width': 0.8 } },
        { id: `${layer}-line-approx`, type: 'line' as const, source, 'source-layer': layer,
          filter: ['==', ['get', 'border_precision'], 1],
          paint: { 'line-color': '#444', 'line-width': 0.8, 'line-dasharray': [3, 2] } },
      ]),
      { id: 'regions-line', type: 'line', source, 'source-layer': 'regions', layout: { visibility: 'none' },
        paint: { 'line-color': '#666', 'line-width': 0.7, 'line-dasharray': [1, 2] } },
      ...historyLayers,
    ],
```
(`tileUrl(TILES_URL, year)` for the source; the `attribution` string becomes `'Borders: <a href="https://www.openhistoricalmap.org/">OpenHistoricalMap</a> (CC0), <a href="https://github.com/aourednik/historical-basemaps">Historical Basemaps</a> (GPL-3.0)'`.)
Handlers:
```ts
let tilesTimer: ReturnType<typeof setTimeout> | undefined;
const setTiles = (y: number) =>
  (map.getSource(source) as maplibregl.VectorTileSource).setTiles([tileUrl(TILES_URL, y)]);
const setTilesSoon = (y: number) => {
  clearTimeout(tilesTimer);
  tilesTimer = setTimeout(() => setTiles(y), 150);
};

function setYear(next: number): void {
  year = next;
  showYear();
  if (mode === 'year') setTilesSoon(year);
}
slider.addEventListener('input', () => setYear(Number(slider.value)));
yearInput.addEventListener('change', () => setYear(clampYear(yearInput.value, min, max, year)));
regionsBox.addEventListener('change', () => {
  map.setLayoutProperty('regions-line', 'visibility', regionsBox.checked && mode === 'year' ? 'visible' : 'none');
});
```
In `setMode`: pin mode → `setTiles(max)` and set both `fallback-fill` and `polity-fill` `fill-color` to `'#e2e2e2'`; hide `regions-line`; year mode → `setTiles(year)`, restore `['get','color']` on both, and `regions-line` visibility per checkbox. `controls.hidden = next === 'pin'` stays. Click handler: `renderPanel(panel, at, periods, regionsBox.checked)` in year mode; in pin mode `fetchHistory(lat, lng, regionsBox.checked)`. Remove all references to `years` and `snapshotYear`. Import `t` for strings.
Update `apps/web/src/main.ts` `window.__map` hook unchanged.

- [ ] **Step 5: Update the e2e tests (RED → GREEN)**

`apps/web/e2e/smoke.spec.ts` changes: helper `const rendered = () => (window as any).__map.queryRenderedFeatures({ layers: ['fallback-fill', 'polity-fill'] }).length > 0;` used in the existing `waitForFunction` calls (replace `['polity-fill']`). The first test now: default year is the current year (`#year-label` equals `String(new Date().getFullYear())`); at lon 2 the polity is Kingdom B (HB fixture, open-ended, features `B1` lon 0..8); then `await page.locator('#year-input').fill('1000'); await page.locator('#year-input').press('Enter');` expect `#year-label` `1000` and after a click `#panel` contains `Kingdom A`. The pin test unchanged except for the render helper. Add:
```ts
test('OHM data wins, HB fills gaps and is marked approximate, regions are optional', async ({ page }) => {
  await page.goto('/?lat=44&lng=2&zoom=5');
  const canvas = page.locator('#map canvas');
  const box = (await canvas.boundingBox())!;
  const center = { x: box.width / 2, y: box.height / 2 };
  const setYear = async (y: string) => {
    await page.locator('#year-input').fill(y);
    await page.locator('#year-input').press('Enter');
    await expect(page.locator('#year-label')).toHaveText(y);
  };

  await setYear('1060');
  await canvas.click({ position: center });
  await expect(page.locator('#panel')).toContainText('Realm X');
  await expect(page.locator('#panel')).not.toContainText('Region R');

  await page.locator('#regions').check();
  await canvas.click({ position: center });
  await expect(page.locator('#panel')).toContainText('Region R');

  await setYear('1090');
  await canvas.click({ position: center });
  await expect(page.locator('#panel')).toContainText('Kingdom A');
  await expect(page.locator('#panel')).toContainText('(approximate)');
});

test('typing an invalid year keeps the map working', async ({ page }) => {
  await page.goto('/');
  await page.locator('#year-input').fill('99999');
  await page.locator('#year-input').press('Enter');
  await expect(page.locator('#year-label')).toHaveText(String(new Date().getFullYear()));
  await page.locator('#year-input').fill('abc');
  await page.locator('#year-input').press('Enter');
  await expect(page.locator('#map canvas')).toBeVisible();
});
```
Run against fixtures (both sources):
```bash
docker compose up -d --build --wait db martin api
DATA_DIR=db/fixtures npm run import
docker compose exec -T db psql -U postgres -d historicalmap < db/fixtures/ohm/staging.sql
OHM_SKIP_LOAD=1 npm run import:ohm
(cd apps/web && npx playwright test)
```
Expected: all e2e PASS. Note the existing "panel shows Kingdom B for lon 2 at the default year" first test depends on HB-only `Kingdom B` at lon 2 (B1 is lon 0..8, open-ended): OHM `Licensed Land`/`Reich ohne Englisch` do not cover lon 2, so B still wins. If the year-typing test fails because `Enter` does not fire `change`, use `.blur()` instead. Restore real data afterwards: `npm run import && npm run import:ohm`.
Run also `npm test -w apps/web && npm run typecheck` → PASS.

- [ ] **Step 6: CI e2e job**

In `.github/workflows/ci.yml`, after `DATA_DIR=db/fixtures npm run import` in the `e2e` job add:
```yaml
      - run: docker compose exec -T db psql -U postgres -d historicalmap < db/fixtures/ohm/staging.sql
      - run: OHM_SKIP_LOAD=1 npm run import:ohm
```
- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: year input, regions toggle and approximate markers in the UI

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Legal pages, README, attribution

**Files:**
- Modify: `apps/web/legal.html`, `README.md`
- Test: `apps/web/e2e/smoke.spec.ts` (extend the legal-pages test)

- [ ] **Step 1: Failing assertion**

In the existing test `legal pages are linked from the map and identify the operator`, after the `Legal Notice` heading assertion add:
```ts
  await expect(main).toContainText('OpenHistoricalMap');
  await expect(main).toContainText('CC0');
```
Run `cd apps/web && npx playwright test -g "legal pages"` → FAIL.

- [ ] **Step 2: Content**

`apps/web/legal.html`: in the "Licenses and attribution" list, add before the Historical Basemaps item:
```html
        <li>
          Historical borders come primarily from
          <a href="https://www.openhistoricalmap.org/" target="_blank" rel="noopener noreferrer">OpenHistoricalMap</a>
          (data dedicated to the public domain under CC0; map data courtesy of the OpenHistoricalMap
          project), and are completed where that data has gaps by
          <a href="https://github.com/aourednik/historical-basemaps" target="_blank" rel="noopener noreferrer">Historical Basemaps</a>
          by Andrew Ourednik, released under the GPL-3.0 license. Areas drawn from Historical Basemaps are
          marked “approximate” in the site.
        </li>
```
and remove the old standalone Historical Basemaps item. Also replace the sentence in "Accuracy and liability" “the data used here is approximate and a work in progress” with “the data used here is approximate and partly a work in progress”. Privacy Policy is unchanged.
`README.md`: update the quick start (add `npm run import:ohm   # downloads ~1.3 GB, needs Docker, ~10 min`), the architecture paragraph (two sources, interval model, OHM precedence, endpoints `/range`, `/at`, `/timeline`, `/history`), the Data section (both sources, CC0 / GPL-3.0, skipped share-alike features), the test section (`OHM_SKIP_LOAD=1 npm run import:ohm` after loading `db/fixtures/ohm/staging.sql` for e2e, plus the reminder to re-import real data), and a note that upgrading from the old schema requires `docker compose down -v`.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run && npm test -w apps/web && npm run typecheck && (cd apps/web && npx playwright test)` (fixtures loaded as in Task 6 Step 5; then restore real data) → Expected: everything PASS.
```bash
git add -A && git commit -m "docs: credit OpenHistoricalMap, update README and legal notice

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** interval model, `source`, `admin_level`, decimal years, migration guard (Task 1); parser, share-alike filter, `resolveTimeline` with 1-year merge and OHM-wins (Task 2); planet download, osm2pgsql without bbox, Europe filter in SQL, per-source reload, skip counts, `name:en`, `MIN_YEAR` (Task 3); `/range`, `/at` regions and `source`, `/timeline`, `/history?levels=` (Task 4); three tile layers (Task 5); year input, debounced tiles, "Regions" checkbox, "(approximate)", opacity, attribution (Task 6); Legal Notice/README (Task 7). Privacy Policy correctly unchanged.
- **Placeholders:** none; the only non-fixed numbers are the real-data smoke counts, which Task 3 Step 5 says to record.
- **Type consistency:** `Interval`/`Period` (Task 2) used by `app.ts` (Task 4); API shapes in Task 4 match `api.ts` (Task 6): `adminLevel`, `source`, `regions`, `level`; layer names `fallback`/`polities`/`regions` match between Task 5 SQL and Task 6 style; `seedOhmFixture` defined in Task 3 and used in Tasks 4-5; `clampYear` defined and used in Task 6.
- **Known risks while executing:** (1) Task 1 is a schema break: the dev DB must be recreated (`docker compose down -v`), the test DB is recreated automatically; (2) exact decimal-year expectations in Task 2 tests come from the formulas in the code comments, verify by running rather than by eye; (3) Task 3 Step 5 downloads ~1.3 GB and runs `osm2pgsql` for several minutes (verified once on the real dump: 6 min 8 s, relations 3863/432/4163 at levels 2/3/4 worldwide); (4) `Enter` on a number input firing `change` in Chromium (fallback: `.blur()`).
