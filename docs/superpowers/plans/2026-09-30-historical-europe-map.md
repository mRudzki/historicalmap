# Historical Europe Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web app where clicking a point on a map/globe of Europe shows which state or pre-state polity owned it, with a year slider colouring each polity's borders and a per-place timeline.

**Architecture:** PostGIS holds Historical Basemaps snapshots. Martin serves MVT tiles from an SQL function `polities_tile(z,x,y,query_params)` filtered by `year`. A thin Fastify API answers point queries (`/snapshots`, `/at`, `/timeline`). A Vite + MapLibre GL frontend (globe projection) renders tiles and a click panel. All backend services run via Docker Compose.

**Tech Stack:** Node 24, TypeScript, npm workspaces, Vitest, PostgreSQL 17 + PostGIS 3.5 (`postgis/postgis:17-3.5`), Martin (`ghcr.io/maplibre/martin:1.16.1`), Fastify 5 + `pg` + `@fastify/cors`, Vite + `maplibre-gl`, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-30-historical-europe-map-design.md`

## Global Constraints

- Whole repo is GPL-3.0 (`LICENSE` already present). Historical Basemaps data is NOT committed; `scripts/fetch-data.sh` fetches it into `data/` (gitignored). Attribution to Historical Basemaps in README and in the map's source attribution.
- Data model exactly: `polities(id, name UNIQUE, subjecto, partof)`, `snapshots(id, year UNIQUE)`, `polity_geometries(polity_id, snapshot_id, geom, border_precision)` with GiST index on `geom`.
- A geometry from snapshot Y is valid until the next snapshot; a year query uses the newest snapshot with `year <= query year`.
- Tile function name `polities_tile`, MVT layer name `polities`, per-feature properties `id`, `name`, `color`, `border_precision`.
- API endpoints: `GET /snapshots`, `GET /at?lat=&lon=&year=`, `GET /timeline?lat=&lon=`. Validation: `lat` -90..90, `lon` -180..180, `year` within the snapshot range; invalid -> HTTP 400. Point with no data -> HTTP 200 with an empty list.
- Import is idempotent and runs in one transaction (truncate + reload).
- Polish UI strings; code identifiers in English.
- Frontend "lint" is `tsc --noEmit` (typecheck); no ESLint in v1.

## Decisions the spec left open (made here)

- Historical Basemaps has global snapshots named `world_<year>.geojson` / `world_bc<year>.geojson`. The importer keeps only features intersecting the Europe bbox (west -25, south 34, east 45, north 72), clips to latitude +-85 (Web Mercator safety), and by default imports only snapshots with year >= 1 (`MIN_YEAR` env overrides).
- ~half of features have `NAME: null` (unclaimed land). They are imported under the sentinel polity name `Unnamed territory` (grey, shown as "Terytorium bez nazwy") so land is not drawn as ocean.
- Extra endpoint `GET /snapshots` (returns `{years: number[]}`) so the slider knows valid years. The slider steps over snapshot indexes, so every step changes the map.
- Polity colour is computed in SQL (`polity_color(name)`, stable hash -> hue), so tiles and the API agree and the style just reads `['get','color']`.

## Review Focus

- Point in the sea / outside all data -> `/at` and `/timeline` return 200 with empty lists (Task 4).
- Year before the first or after the last snapshot -> 400; year between snapshots -> floors to the earlier snapshot (Task 4).
- Longitude outside +-180 (globe clicks can overshoot) -> API 400; the frontend wraps it with `lngLat.wrap()` (Tasks 4, 6).
- Invalid/self-intersecting source polygon (bowtie) must not abort the import (Task 2).
- Same polity with several features in one snapshot -> reported once by `/at` and `/timeline` (Task 4).
- Tile request with missing, non-numeric or out-of-range `year` -> empty tile, not an error (Task 3).
- Empty database -> `/snapshots` returns `{years: []}`, `/at` returns 400 (Task 4).

---

## File Structure

```
package.json                 root: workspaces, scripts, shared devDeps
tsconfig.json                shared TS config (typecheck)
vitest.config.ts             backend test config (db, scripts, api)
docker-compose.yml           db, martin, api
.gitignore  .github/workflows/ci.yml  README.md
db/01-schema.sql             tables + indexes
db/02-functions.sql          snapshot_for_year, polity_color, polities_tile
db/global-setup.ts           vitest: create test DB + apply schema
db/test-support.ts           shared test helpers (pool, seed, clear)
db/fixtures/*.geojson        tiny Historical-Basemaps-shaped snapshots
db/schema.test.ts  db/tile.test.ts
scripts/fetch-data.sh        clone Historical Basemaps into data/
scripts/import-lib.ts        parseSnapshotYear, importDirectory
scripts/import.ts            CLI entry
scripts/import.test.ts
apps/api/src/{app,timeline,server}.ts   Fastify app, timeline logic, entry
apps/api/test/{timeline,app}.test.ts
apps/api/Dockerfile
apps/web/{index.html,vite.config.ts,package.json}
apps/web/src/{format,api,panel,main}.ts  apps/web/src/style.css
apps/web/src/format.test.ts
apps/web/e2e/smoke.spec.ts  apps/web/playwright.config.ts
```

---

### Task 1: Scaffold, schema, test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `docker-compose.yml` (db service only for now)
- Create: `db/01-schema.sql`, `db/02-functions.sql` (empty placeholder comment for now), `db/global-setup.ts`, `db/test-support.ts`
- Test: `db/schema.test.ts`

**Interfaces:**
- Produces: `db/test-support.ts` exports `ADMIN_URL`, `TEST_URL`, `FIXTURE_DIR`, `applySchema(pool)`, `testPool()`, `clearAll(pool)`, `seedFixture(pool)` (`seedFixture` is added in Task 2 when the importer exists). npm scripts `test`, `typecheck`.

- [ ] **Step 1: Create root package.json, tsconfig, vitest config, .gitignore**

`package.json`:
```json
{
  "name": "historicalmap",
  "private": true,
  "type": "module",
  "license": "GPL-3.0-only",
  "workspaces": ["apps/*"],
  "scripts": {
    "test": "vitest run && npm test -w apps/web",
    "typecheck": "tsc --noEmit -p . && tsc --noEmit -p apps/web",
    "import": "tsx scripts/import.ts",
    "start:api": "tsx apps/api/src/server.ts"
  },
  "devDependencies": {
    "@mapbox/vector-tile": "^3.0.0",
    "@types/node": "^24.0.0",
    "@types/pg": "^8.0.0",
    "pbf": "^5.0.0",
    "pg": "^8.0.0",
    "tsx": "^4.0.0",
    "typescript": "^7.0.0",
    "vitest": "^5.0.0"
  }
}
```
`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "types": ["node"], "lib": ["ES2022"]
  },
  "include": ["db", "scripts", "apps/api"]
}
```
`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['db/**/*.test.ts', 'scripts/**/*.test.ts', 'apps/api/**/*.test.ts'],
    globalSetup: ['db/global-setup.ts'],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
```
`.gitignore`:
```
node_modules/
data/
dist/
.env
playwright-report/
test-results/
```

- [ ] **Step 2: docker-compose.yml with db**

```yaml
services:
  db:
    image: postgis/postgis:17-3.5
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: historicalmap
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./db:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -h 127.0.0.1 -d historicalmap"]
      interval: 3s
      retries: 20
volumes:
  pgdata:
```
Note: only `*.sql` files in `db/` run at first init; the `.ts` files are ignored.

- [ ] **Step 3: Write schema, and the failing test**

`db/01-schema.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS polities (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  subjecto text,
  partof text
);

CREATE TABLE IF NOT EXISTS snapshots (
  id serial PRIMARY KEY,
  year integer NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS polity_geometries (
  polity_id integer NOT NULL REFERENCES polities(id) ON DELETE CASCADE,
  snapshot_id integer NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  border_precision smallint
);

CREATE INDEX IF NOT EXISTS polity_geometries_geom_idx
  ON polity_geometries USING gist (geom);
CREATE INDEX IF NOT EXISTS polity_geometries_snapshot_idx
  ON polity_geometries (snapshot_id);
```
`db/02-functions.sql`: `-- functions are added in Task 3` (single comment line).

`db/test-support.ts`:
```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
export const TEST_DB = 'historicalmap_test';
export const TEST_URL =
  process.env.TEST_DATABASE_URL ?? `postgres://postgres:postgres@localhost:5432/${TEST_DB}`;

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(here, 'fixtures');

export async function applySchema(pool: pg.Pool): Promise<void> {
  for (const file of ['01-schema.sql', '02-functions.sql']) {
    await pool.query(await readFile(path.join(here, file), 'utf8'));
  }
}

export function testPool(): pg.Pool {
  return new pg.Pool({ connectionString: TEST_URL });
}

export async function clearAll(pool: pg.Pool): Promise<void> {
  await pool.query(
    'TRUNCATE polity_geometries, snapshots, polities RESTART IDENTITY CASCADE',
  );
}
```
`db/global-setup.ts`:
```ts
import pg from 'pg';
import { ADMIN_URL, TEST_DB, TEST_URL, applySchema } from './test-support';

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: TEST_URL });
  await applySchema(pool);
  await pool.end();
}
```
`db/schema.test.ts`:
```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearAll, testPool } from './test-support';

const pool = testPool();
beforeEach(() => clearAll(pool));
afterAll(() => pool.end());

describe('schema', () => {
  it('rejects two polities with the same name', async () => {
    await pool.query("INSERT INTO polities (name) VALUES ('Kingdom A')");
    await expect(pool.query("INSERT INTO polities (name) VALUES ('Kingdom A')")).rejects.toThrow(
      /unique/i,
    );
  });

  it('rejects a non-MultiPolygon geometry', async () => {
    await pool.query("INSERT INTO polities (name) VALUES ('P')");
    await pool.query('INSERT INTO snapshots (year) VALUES (1000)');
    await expect(
      pool.query(
        "INSERT INTO polity_geometries (polity_id, snapshot_id, geom) VALUES (1, 1, ST_SetSRID(ST_MakePoint(1,1),4326))",
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Install deps, start DB, run tests**

```bash
npm install
docker compose up -d --wait db
npx vitest run db/schema.test.ts
```
Expected: 2 tests PASS. (Before Step 3's SQL exists the run fails on missing tables; write the SQL then run.) Note: `npm test` also runs `apps/web` tests, which do not exist yet; use `npx vitest run` until Task 6.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: scaffold workspace, DB schema and test harness

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Importer

**Files:**
- Create: `scripts/import-lib.ts`, `scripts/import.ts`, `scripts/fetch-data.sh`
- Create: `db/fixtures/world_1000.geojson`, `db/fixtures/world_1100.geojson`, `db/fixtures/world_bc500.geojson`
- Modify: `db/test-support.ts` (add `seedFixture`)
- Test: `scripts/import.test.ts`

**Interfaces:**
- Consumes: `applySchema`, `testPool`, `clearAll`, `FIXTURE_DIR` from Task 1.
- Produces: `parseSnapshotYear(filename: string): number | null`; `importDirectory(pool: pg.Pool, dir: string, opts?: { minYear?: number }): Promise<{ snapshots: number; features: number }>`; constant `UNNAMED = 'Unnamed territory'`; `seedFixture(pool)` in test-support.

- [ ] **Step 1: Create fixtures**

Every feature is a `MultiPolygon` with properties `{NAME, ABBREVN, SUBJECTO, BORDERPRECISION, PARTOF}`.

`db/fixtures/world_1000.geojson`:
```json
{"type":"FeatureCollection","features":[
 {"type":"Feature","properties":{"NAME":"Kingdom A","ABBREVN":null,"SUBJECTO":null,"BORDERPRECISION":2,"PARTOF":null},
  "geometry":{"type":"MultiPolygon","coordinates":[[[[0,40],[10,40],[10,50],[0,50],[0,40]]]]}},
 {"type":"Feature","properties":{"NAME":"Kingdom B","ABBREVN":null,"SUBJECTO":null,"BORDERPRECISION":1,"PARTOF":null},
  "geometry":{"type":"MultiPolygon","coordinates":[[[[5,40],[15,40],[15,50],[5,50],[5,40]]]]}},
 {"type":"Feature","properties":{"NAME":null,"ABBREVN":null,"SUBJECTO":null,"BORDERPRECISION":1,"PARTOF":null},
  "geometry":{"type":"MultiPolygon","coordinates":[[[[20,40],[25,40],[25,45],[20,45],[20,40]]]]}},
 {"type":"Feature","properties":{"NAME":"Far Empire","ABBREVN":null,"SUBJECTO":null,"BORDERPRECISION":1,"PARTOF":null},
  "geometry":{"type":"MultiPolygon","coordinates":[[[[100,40],[110,40],[110,50],[100,50],[100,40]]]]}}
]}
```
`db/fixtures/world_1100.geojson` (Kingdom B appears as two adjacent features touching at lon 8):
```json
{"type":"FeatureCollection","features":[
 {"type":"Feature","properties":{"NAME":"Kingdom B","ABBREVN":null,"SUBJECTO":null,"BORDERPRECISION":1,"PARTOF":null},
  "geometry":{"type":"MultiPolygon","coordinates":[[[[0,40],[8,40],[8,50],[0,50],[0,40]]]]}},
 {"type":"Feature","properties":{"NAME":"Kingdom B","ABBREVN":null,"SUBJECTO":null,"BORDERPRECISION":1,"PARTOF":null},
  "geometry":{"type":"MultiPolygon","coordinates":[[[[8,40],[15,40],[15,50],[8,50],[8,40]]]]}}
]}
```
`db/fixtures/world_bc500.geojson`:
```json
{"type":"FeatureCollection","features":[
 {"type":"Feature","properties":{"NAME":"Ancient Realm","ABBREVN":null,"SUBJECTO":null,"BORDERPRECISION":1,"PARTOF":null},
  "geometry":{"type":"MultiPolygon","coordinates":[[[[0,40],[5,40],[5,45],[0,45],[0,40]]]]}}
]}
```

- [ ] **Step 2: Write the failing tests**

`scripts/import.test.ts`:
```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_DIR, clearAll, testPool } from '../db/test-support';
import { UNNAMED, importDirectory, parseSnapshotYear } from './import-lib';

const pool = testPool();
beforeEach(() => clearAll(pool));
afterAll(() => pool.end());

describe('parseSnapshotYear', () => {
  it('parses AD, BC and rejects other names', () => {
    expect(parseSnapshotYear('world_1400.geojson')).toBe(1400);
    expect(parseSnapshotYear('world_bc500.geojson')).toBe(-500);
    expect(parseSnapshotYear('places.geojson')).toBeNull();
    expect(parseSnapshotYear('world_1400.svg')).toBeNull();
  });
});

describe('importDirectory', () => {
  it('imports AD snapshots, keeps only Europe, maps null NAME to the sentinel', async () => {
    const result = await importDirectory(pool, FIXTURE_DIR);
    expect(result).toEqual({ snapshots: 2, features: 5 });

    const names = await pool.query('SELECT name FROM polities ORDER BY name');
    expect(names.rows.map((r) => r.name)).toEqual(['Kingdom A', 'Kingdom B', UNNAMED]);

    const years = await pool.query('SELECT year FROM snapshots ORDER BY year');
    expect(years.rows.map((r) => r.year)).toEqual([1000, 1100]);
  });

  it('honours minYear and stores BC years as negatives', async () => {
    const result = await importDirectory(pool, FIXTURE_DIR, { minYear: -1000 });
    expect(result.snapshots).toBe(3);
    const years = await pool.query('SELECT year FROM snapshots ORDER BY year');
    expect(years.rows.map((r) => r.year)).toEqual([-500, 1000, 1100]);
  });

  it('is idempotent', async () => {
    await importDirectory(pool, FIXTURE_DIR);
    await importDirectory(pool, FIXTURE_DIR);
    const count = await pool.query('SELECT count(*)::int AS n FROM polity_geometries');
    expect(count.rows[0].n).toBe(5);
  });

  it('survives a self-intersecting (bowtie) polygon', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hm-'));
    const bowtie = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { NAME: 'Bowtie Land', BORDERPRECISION: 1 },
          geometry: { type: 'MultiPolygon', coordinates: [[[[0, 40], [10, 50], [10, 40], [0, 50], [0, 40]]]] },
        },
      ],
    };
    await writeFile(path.join(dir, 'world_1500.geojson'), JSON.stringify(bowtie));
    const result = await importDirectory(pool, dir);
    expect(result.features).toBe(1);
    const valid = await pool.query('SELECT bool_and(ST_IsValid(geom)) AS ok FROM polity_geometries');
    expect(valid.rows[0].ok).toBe(true);
  });

  it('rolls back completely when a file is broken', async () => {
    await importDirectory(pool, FIXTURE_DIR);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hm-'));
    await writeFile(path.join(dir, 'world_1500.geojson'), '{ not json');
    await expect(importDirectory(pool, dir)).rejects.toThrow();
    const count = await pool.query('SELECT count(*)::int AS n FROM polity_geometries');
    expect(count.rows[0].n).toBe(5); // previous data untouched
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run scripts/import.test.ts`
Expected: FAIL (`Cannot find module './import-lib'`).

- [ ] **Step 4: Implement the importer**

`scripts/import-lib.ts`:
```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

export const UNNAMED = 'Unnamed territory';
export const EUROPE_BBOX = { west: -25, south: 34, east: 45, north: 72 } as const;

export function parseSnapshotYear(filename: string): number | null {
  const m = /^world_(bc)?(\d+)\.geojson$/.exec(filename);
  if (!m) return null;
  const n = Number(m[2]);
  return m[1] ? -n : n;
}

interface Feature {
  properties: {
    NAME?: string | null;
    SUBJECTO?: string | null;
    PARTOF?: string | null;
    BORDERPRECISION?: number | null;
  };
  geometry: unknown;
}

// One statement per feature: build a valid, clipped MultiPolygon, keep it only if it
// touches Europe, upsert the polity, insert the geometry. rowCount = 1 when kept.
const INSERT_FEATURE = `
WITH g AS (
  SELECT ST_Multi(ST_CollectionExtract(
    ST_Intersection(
      ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326)),
      ST_MakeEnvelope(-180, -85, 180, 85, 4326)),
    3)) AS geom
), keep AS (
  SELECT geom FROM g
  WHERE NOT ST_IsEmpty(geom)
    AND ST_Intersects(geom, ST_MakeEnvelope($2::float8, $3::float8, $4::float8, $5::float8, 4326))
), p AS (
  INSERT INTO polities (name, subjecto, partof)
  SELECT $6::text, $7::text, $8::text FROM keep
  ON CONFLICT (name) DO UPDATE SET
    subjecto = COALESCE(EXCLUDED.subjecto, polities.subjecto),
    partof = COALESCE(EXCLUDED.partof, polities.partof)
  RETURNING id
)
INSERT INTO polity_geometries (polity_id, snapshot_id, geom, border_precision)
SELECT p.id, $9::int, keep.geom, $10::smallint FROM p, keep`;

export async function importDirectory(
  pool: pg.Pool,
  dir: string,
  opts: { minYear?: number } = {},
): Promise<{ snapshots: number; features: number }> {
  const minYear = opts.minYear ?? 1;
  const files = (await readdir(dir))
    .map((name) => ({ name, year: parseSnapshotYear(name) }))
    .filter((f): f is { name: string; year: number } => f.year !== null && f.year >= minYear)
    .sort((a, b) => a.year - b.year);

  // Parse everything before touching the DB so a broken file cannot half-import.
  const parsed: { year: number; features: Feature[] }[] = [];
  for (const f of files) {
    const json = JSON.parse(await readFile(path.join(dir, f.name), 'utf8'));
    parsed.push({ year: f.year, features: json.features as Feature[] });
  }

  const client = await pool.connect();
  let features = 0;
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE polity_geometries, snapshots, polities RESTART IDENTITY CASCADE');
    for (const snap of parsed) {
      const { rows } = await client.query('INSERT INTO snapshots (year) VALUES ($1) RETURNING id', [snap.year]);
      const snapshotId: number = rows[0].id;
      for (const feat of snap.features) {
        if (!feat.geometry) continue;
        const p = feat.properties;
        const res = await client.query(INSERT_FEATURE, [
          JSON.stringify(feat.geometry),
          EUROPE_BBOX.west, EUROPE_BBOX.south, EUROPE_BBOX.east, EUROPE_BBOX.north,
          p.NAME ?? UNNAMED, p.SUBJECTO ?? null, p.PARTOF ?? null,
          snapshotId, p.BORDERPRECISION ?? null,
        ]);
        features += res.rowCount ?? 0;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { snapshots: parsed.length, features };
}
```
`scripts/import.ts`:
```ts
import pg from 'pg';
import { importDirectory } from './import-lib';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/historicalmap';
const dir = process.env.DATA_DIR ?? 'data/historical-basemaps/geojson';
const minYear = process.env.MIN_YEAR ? Number(process.env.MIN_YEAR) : undefined;

const pool = new pg.Pool({ connectionString: url });
try {
  const result = await importDirectory(pool, dir, { minYear });
  console.log(`Imported ${result.features} features in ${result.snapshots} snapshots from ${dir}`);
} finally {
  await pool.end();
}
```
`scripts/fetch-data.sh` (then `chmod +x`):
```bash
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
```
Add to `db/test-support.ts`:
```ts
import { importDirectory } from '../scripts/import-lib';

export async function seedFixture(pool: pg.Pool): Promise<void> {
  await importDirectory(pool, FIXTURE_DIR);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run scripts/import.test.ts`
Expected: 6 tests PASS. If the bowtie test fails with a geometry-type error, `ST_CollectionExtract(..., 3)` is returning an empty result for a degenerate repair — inspect `ST_MakeValid` output for the bowtie (it yields a MultiPolygon of two triangles) before changing the query.

- [ ] **Step 6: Smoke the real data (manual, not committed)**

```bash
scripts/fetch-data.sh && npm run import
```
Expected: a line like `Imported N features in ~35 snapshots`. Record the count; it is a sanity check, not an assertion.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: Historical Basemaps importer with fixtures

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: SQL functions and tile function

**Files:**
- Modify: `db/02-functions.sql`
- Test: `db/tile.test.ts`

**Interfaces:**
- Consumes: `seedFixture`, `clearAll`, `testPool` (Tasks 1-2).
- Produces SQL: `snapshot_for_year(integer) -> integer` (snapshot id or NULL); `polity_color(text) -> text` (CSS `hsl(...)`); `polities_tile(z integer, x integer, y integer, query_params json) -> bytea` (empty bytea when nothing to draw). Layer `polities` properties: `id`, `name`, `color`, `border_precision`.

- [ ] **Step 1: Write the failing tests**

`db/tile.test.ts`:
```ts
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearAll, seedFixture, testPool } from './test-support';

const pool = testPool();

beforeAll(async () => {
  await clearAll(pool);
  await seedFixture(pool);
});
afterAll(() => pool.end());

async function tile(z: number, x: number, y: number, params: Record<string, string>) {
  const { rows } = await pool.query('SELECT polities_tile($1,$2,$3,$4::json) AS t', [
    z, x, y, JSON.stringify(params),
  ]);
  return rows[0].t as Buffer;
}

function decode(buf: Buffer) {
  const layer = new VectorTile(new PbfReader(buf)).layers.polities;
  if (!layer) return [];
  return Array.from({ length: layer.length }, (_, i) => layer.feature(i).properties);
}

describe('snapshot_for_year', () => {
  it('floors to the newest snapshot not after the year, else NULL', async () => {
    const q = (y: number) => pool.query('SELECT s.year FROM snapshots s WHERE s.id = snapshot_for_year($1)', [y]);
    expect((await q(1000)).rows[0].year).toBe(1000);
    expect((await q(1099)).rows[0].year).toBe(1000);
    expect((await q(1500)).rows[0].year).toBe(1100);
    expect((await q(999)).rowCount).toBe(0);
  });
});

describe('polity_color', () => {
  it('is stable, an hsl string, and grey for the unnamed sentinel', async () => {
    const { rows } = await pool.query(
      "SELECT polity_color('Kingdom A') AS a, polity_color('Kingdom A') AS a2, polity_color('Unnamed territory') AS u",
    );
    expect(rows[0].a).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
    expect(rows[0].a).toBe(rows[0].a2);
    expect(rows[0].u).toBe('hsl(0, 0%, 80%)');
  });
});

describe('polities_tile', () => {
  it('returns the polities of the snapshot for the requested year', async () => {
    const names = decode(await tile(0, 0, 0, { year: '1000' })).map((f) => f.name).sort();
    expect(names).toEqual(['Kingdom A', 'Kingdom B', 'Unnamed territory']);
    const later = decode(await tile(0, 0, 0, { year: '1100' })).map((f) => f.name);
    expect(later).toEqual(['Kingdom B', 'Kingdom B']);
  });

  it('exposes id, name, color and border_precision', async () => {
    const a = decode(await tile(0, 0, 0, { year: '1000' })).find((f) => f.name === 'Kingdom A');
    expect(a).toMatchObject({ name: 'Kingdom A', border_precision: 2 });
    expect(a?.color).toMatch(/^hsl\(/);
    expect(a?.id).toBeTypeOf('number');
  });

  it('returns an empty tile where there is no data', async () => {
    expect((await tile(4, 0, 0, { year: '1000' })).length).toBe(0); // far west Pacific
  });

  it.each([
    ['missing year', {}],
    ['non-numeric year', { year: 'abc' }],
    ['year before first snapshot', { year: '999' }],
  ])('returns an empty tile for %s, not an error', async (_label, params) => {
    expect((await tile(0, 0, 0, params)).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run db/tile.test.ts`
Expected: FAIL (`function snapshot_for_year(integer) does not exist`).

- [ ] **Step 3: Implement the functions**

`db/02-functions.sql` (replace the placeholder):
```sql
CREATE OR REPLACE FUNCTION snapshot_for_year(y integer) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT id FROM snapshots WHERE year <= y ORDER BY year DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION polity_color(polity_name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN polity_name = 'Unnamed territory' THEN 'hsl(0, 0%, 80%)'
    ELSE 'hsl(' ||
      (('x' || substr(md5(polity_name), 1, 7))::bit(28)::int % 360) || ', 55%, 60%)'
  END
$$;

-- Martin function source: tile (z,x,y) for the snapshot valid in ?year=
CREATE OR REPLACE FUNCTION polities_tile(z integer, x integer, y integer, query_params json DEFAULT '{}')
RETURNS bytea LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  year_text text := query_params->>'year';
  snap integer;
  bounds geometry := ST_TileEnvelope(z, x, y);
  result bytea;
BEGIN
  IF year_text IS NULL OR year_text !~ '^-?[0-9]{1,6}$' THEN
    RETURN ''::bytea;
  END IF;
  snap := snapshot_for_year(year_text::integer);
  IF snap IS NULL THEN
    RETURN ''::bytea;
  END IF;

  SELECT ST_AsMVT(t, 'polities', 4096, 'geom') INTO result
  FROM (
    SELECT p.id, p.name, polity_color(p.name) AS color, g.border_precision,
           ST_AsMVTGeom(ST_Transform(g.geom, 3857), bounds, 4096, 64, true) AS geom
    FROM polity_geometries g
    JOIN polities p ON p.id = g.polity_id
    WHERE g.snapshot_id = snap AND g.geom && ST_Transform(bounds, 4326)
  ) t
  WHERE t.geom IS NOT NULL;

  RETURN COALESCE(result, ''::bytea);
END
$$;
```
Then re-apply: the test global setup runs `applySchema` on every `vitest run`, so no manual step.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run db/`
Expected: all PASS. If the "no data" tile is non-empty, the tile at z4/0/0 covers lon -180..-157: confirm no fixture geometry lies there.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: snapshot lookup, polity colour and MVT tile function

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: API

**Files:**
- Create: `apps/api/package.json`, `apps/api/src/timeline.ts`, `apps/api/src/app.ts`, `apps/api/src/server.ts`
- Test: `apps/api/test/timeline.test.ts`, `apps/api/test/app.test.ts`

**Interfaces:**
- Consumes: SQL from Task 3; test helpers.
- Produces:
  - `buildTimeline(rows: TimelineRow[], allYears: number[]): Period[]` with `TimelineRow = {name: string; color: string; year: number}`, `Period = {name: string; color: string; from: number; to: number | null}` (`to` = year of the next snapshot after the run, `null` when the run reaches the last snapshot).
  - `createApp(pool: pg.Pool): FastifyInstance`.
  - `GET /snapshots` -> `{years: number[]}`; `GET /at` -> `{year: number, snapshotYear: number|null, polities: {id, name, subjecto, borderPrecision, color}[]}`; `GET /timeline` -> `{periods: Period[]}`.

- [ ] **Step 1: apps/api/package.json and install**

```json
{
  "name": "@historicalmap/api",
  "private": true,
  "type": "module",
  "dependencies": {
    "@fastify/cors": "^11.0.0",
    "fastify": "^5.0.0",
    "pg": "^8.0.0"
  }
}
```
Run: `npm install`.

- [ ] **Step 2: Write the failing tests for buildTimeline**

`apps/api/test/timeline.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../src/timeline';

const years = [1000, 1100, 1200, 1300];

describe('buildTimeline', () => {
  it('merges consecutive snapshots and ends at the next snapshot year', () => {
    const rows = [
      { name: 'A', color: 'c1', year: 1000 },
      { name: 'A', color: 'c1', year: 1100 },
    ];
    expect(buildTimeline(rows, years)).toEqual([{ name: 'A', color: 'c1', from: 1000, to: 1200 }]);
  });

  it('leaves `to` null when the run reaches the last snapshot', () => {
    const rows = [{ name: 'A', color: 'c1', year: 1300 }];
    expect(buildTimeline(rows, years)).toEqual([{ name: 'A', color: 'c1', from: 1300, to: null }]);
  });

  it('splits a polity that disappears and comes back', () => {
    const rows = [
      { name: 'A', color: 'c1', year: 1000 },
      { name: 'A', color: 'c1', year: 1200 },
    ];
    expect(buildTimeline(rows, years)).toEqual([
      { name: 'A', color: 'c1', from: 1000, to: 1100 },
      { name: 'A', color: 'c1', from: 1200, to: 1300 },
    ]);
  });

  it('ignores duplicate rows and sorts by start then name', () => {
    const rows = [
      { name: 'B', color: 'c2', year: 1000 },
      { name: 'B', color: 'c2', year: 1000 },
      { name: 'A', color: 'c1', year: 1000 },
    ];
    expect(buildTimeline(rows, years).map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('returns [] for no rows', () => {
    expect(buildTimeline([], years)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify failure, then implement**

Run: `npx vitest run apps/api/test/timeline.test.ts` -> FAIL (module missing).

`apps/api/src/timeline.ts`:
```ts
export interface TimelineRow { name: string; color: string; year: number }
export interface Period { name: string; color: string; from: number; to: number | null }

export function buildTimeline(rows: TimelineRow[], allYears: number[]): Period[] {
  const sorted = [...allYears].sort((a, b) => a - b);
  const indexOf = new Map(sorted.map((y, i) => [y, i]));

  const byName = new Map<string, { color: string; idx: Set<number> }>();
  for (const r of rows) {
    const i = indexOf.get(r.year);
    if (i === undefined) continue;
    const entry = byName.get(r.name) ?? { color: r.color, idx: new Set<number>() };
    entry.idx.add(i);
    byName.set(r.name, entry);
  }

  const periods: Period[] = [];
  for (const [name, { color, idx }] of byName) {
    const list = [...idx].sort((a, b) => a - b);
    let start = list[0];
    let prev = list[0];
    const flush = () =>
      periods.push({ name, color, from: sorted[start], to: sorted[prev + 1] ?? null });
    for (const i of list.slice(1)) {
      if (i === prev + 1) { prev = i; continue; }
      flush();
      start = i;
      prev = i;
    }
    flush();
  }
  return periods.sort((a, b) => a.from - b.from || a.name.localeCompare(b.name));
}
```
Run again -> 5 PASS.

- [ ] **Step 5: Write the failing endpoint tests**

`apps/api/test/app.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearAll, seedFixture, testPool } from '../../../db/test-support';
import { createApp } from '../src/app';

const pool = testPool();
const app = createApp(pool);

beforeAll(async () => {
  await clearAll(pool);
  await seedFixture(pool);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const get = (url: string) => app.inject({ method: 'GET', url });
const names = (body: string) => JSON.parse(body).polities.map((p: { name: string }) => p.name).sort();

describe('GET /snapshots', () => {
  it('lists snapshot years ascending', async () => {
    const res = await get('/snapshots');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ years: [1000, 1100] });
  });
});

describe('GET /at', () => {
  it('returns the polity at a point', async () => {
    const res = await get('/at?lat=45&lon=2&year=1000');
    expect(res.statusCode).toBe(200);
    expect(res.json().snapshotYear).toBe(1000);
    expect(names(res.body)).toEqual(['Kingdom A']);
  });

  it('returns every overlapping polity', async () => {
    expect(names((await get('/at?lat=45&lon=7&year=1000')).body)).toEqual(['Kingdom A', 'Kingdom B']);
  });

  it('floors a year between snapshots to the earlier snapshot', async () => {
    const res = await get('/at?lat=45&lon=7&year=1050');
    expect(res.json().snapshotYear).toBe(1000);
  });

  it('reports a polity once even if it has several features at the point', async () => {
    const res = await get('/at?lat=45&lon=8&year=1100'); // on the seam of two Kingdom B features
    expect(names(res.body)).toEqual(['Kingdom B']);
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
    ['year before first snapshot', '/at?lat=45&lon=2&year=999'],
    ['year after last snapshot', '/at?lat=45&lon=2&year=1101'],
  ])('rejects %s with 400', async (_l, url) => {
    expect((await get(url)).statusCode).toBe(400);
  });
});

describe('GET /timeline', () => {
  it('builds the timeline of a point', async () => {
    const res = await get('/timeline?lat=45&lon=7');
    expect(res.json().periods).toEqual([
      { name: 'Kingdom A', color: expect.stringMatching(/^hsl/), from: 1000, to: 1100 },
      { name: 'Kingdom B', color: expect.stringMatching(/^hsl/), from: 1000, to: null },
    ]);
  });

  it('includes unnamed territory as its own period', async () => {
    const res = await get('/timeline?lat=42&lon=22');
    expect(res.json().periods).toEqual([
      { name: 'Unnamed territory', color: 'hsl(0, 0%, 80%)', from: 1000, to: 1100 },
    ]);
  });

  it('returns 200 with no periods for the sea', async () => {
    const res = await get('/timeline?lat=0&lon=-30');
    expect(res.statusCode).toBe(200);
    expect(res.json().periods).toEqual([]);
  });

  it('rejects out-of-range coordinates', async () => {
    expect((await get('/timeline?lat=45&lon=181')).statusCode).toBe(400);
  });
});

describe('empty database', () => {
  it('returns no snapshots and 400 on /at', async () => {
    await clearAll(pool);
    expect((await get('/snapshots')).json()).toEqual({ years: [] });
    expect((await get('/at?lat=45&lon=2&year=1000')).statusCode).toBe(400);
    await seedFixture(pool);
  });
});
```
Run: `npx vitest run apps/api` -> FAIL (`../src/app` missing).

- [ ] **Step 6: Implement the app**

`apps/api/src/app.ts`:
```ts
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildTimeline } from './timeline';

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

const POINT = 'ST_SetSRID(ST_MakePoint($1, $2), 4326)';

export function createApp(pool: pg.Pool): FastifyInstance {
  const app = Fastify();
  app.register(cors, { origin: true });

  const snapshotYears = async (): Promise<number[]> => {
    const { rows } = await pool.query('SELECT year FROM snapshots ORDER BY year');
    return rows.map((r) => r.year as number);
  };

  app.get('/snapshots', async () => ({ years: await snapshotYears() }));

  app.get('/at', { schema: atSchema }, async (req, reply) => {
    const { lat, lon, year } = req.query as { lat: number; lon: number; year: number };
    const years = await snapshotYears();
    if (years.length === 0 || year < years[0] || year > years[years.length - 1]) {
      return reply.code(400).send({ error: 'year out of range', min: years[0] ?? null, max: years.at(-1) ?? null });
    }
    const snap = await pool.query(
      'SELECT s.id, s.year FROM snapshots s WHERE s.id = snapshot_for_year($1)',
      [year],
    );
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (p.id) p.id, p.name, p.subjecto,
              g.border_precision AS "borderPrecision", polity_color(p.name) AS color
       FROM polity_geometries g JOIN polities p ON p.id = g.polity_id
       WHERE g.snapshot_id = $3 AND ST_Intersects(g.geom, ${POINT})
       ORDER BY p.id, g.border_precision DESC NULLS LAST`,
      [lon, lat, snap.rows[0].id],
    );
    return { year, snapshotYear: snap.rows[0].year as number, polities: rows };
  });

  app.get('/timeline', { schema: timelineSchema }, async (req) => {
    const { lat, lon } = req.query as { lat: number; lon: number };
    const { rows } = await pool.query(
      `SELECT DISTINCT p.name, polity_color(p.name) AS color, s.year
       FROM polity_geometries g
       JOIN polities p ON p.id = g.polity_id
       JOIN snapshots s ON s.id = g.snapshot_id
       WHERE ST_Intersects(g.geom, ${POINT})`,
      [lon, lat],
    );
    return { periods: buildTimeline(rows, await snapshotYears()) };
  });

  return app;
}
```
`apps/api/src/server.ts`:
```ts
import pg from 'pg';
import { createApp } from './app';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/historicalmap',
});
const app = createApp(pool);
const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });
console.log(`API listening on :${port}`);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run apps/api`
Expected: all PASS. Fastify coerces `lat=abc` to a validation error (400) by default; if `year=1050` is rejected as non-integer, it is not - it is an integer.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: API with /snapshots, /at and /timeline

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docker Compose stack (Martin + API)

**Files:**
- Create: `apps/api/Dockerfile`, `.dockerignore`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: `polities_tile` (Task 3), API (Task 4).
- Produces: Martin on `:3000` serving `http://localhost:3000/polities_tile/{z}/{x}/{y}?year=Y`; API on `:3001`.

- [ ] **Step 1: Dockerfile and dockerignore**

`.dockerignore`:
```
node_modules
data
.git
docs
**/node_modules
```
`apps/api/Dockerfile` (build context is the repo root):
```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace apps/api --include-workspace-root
COPY apps/api apps/api
EXPOSE 3001
CMD ["npx", "tsx", "apps/api/src/server.ts"]
```
(`apps/web/package.json` is created in Task 6; until then this COPY fails, so build the image only after Task 6, or create the web `package.json` first.)

- [ ] **Step 2: Extend docker-compose.yml**

Add under `services:`:
```yaml
  martin:
    image: ghcr.io/maplibre/martin:1.16.1
    environment:
      DATABASE_URL: postgres://postgres:postgres@db:5432/historicalmap
    ports: ["3000:3000"]
    depends_on:
      db: { condition: service_healthy }

  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    environment:
      DATABASE_URL: postgres://postgres:postgres@db:5432/historicalmap
    ports: ["3001:3001"]
    depends_on:
      db: { condition: service_healthy }
```

- [ ] **Step 3: Verify Martin discovers the function and serves a tile**

```bash
docker compose up -d --wait db martin
DATA_DIR=db/fixtures npm run import
curl -s localhost:3000/catalog | head -c 600
curl -s -o /tmp/t.pbf -w '%{http_code} %{size_download}\n' 'localhost:3000/polities_tile/0/0/0?year=1000'
```
Expected: `/catalog` lists `polities_tile` under `tiles`; the tile request prints `200` and a non-zero size. If the catalog lacks the function, Martin started before the function existed: `docker compose restart martin`. If the function name in the catalog is schema-qualified, use that exact name in `tileUrl` in Task 6.

- [ ] **Step 4: Verify the API container (after Task 6 creates apps/web/package.json)**

Run `docker compose up -d --build --wait api && curl -s localhost:3001/snapshots`. Expected: `{"years":[1000,1100]}`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: docker compose stack with Martin and API

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Frontend

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/{vite-env.d.ts,format.ts,api.ts,panel.ts,main.ts,style.css}`
- Test: `apps/web/src/format.test.ts`

**Interfaces:**
- Consumes: API responses (Task 4), tile URL (Task 5).
- Produces: `formatYear(y: number): string`, `polityLabel(name: string): string`, `tileUrl(base: string, year: number): string` in `format.ts`.

- [ ] **Step 1: Package, tsconfig, vite config**

`apps/web/package.json`:
```json
{
  "name": "@historicalmap/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": { "maplibre-gl": "^6.0.0" },
  "devDependencies": { "@playwright/test": "^1.50.0", "vite": "^8.0.0", "vitest": "^5.0.0" }
}
```
`apps/web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": ["vite/client"]
  },
  "include": ["src", "e2e", "playwright.config.ts", "vite.config.ts"]
}
```
`apps/web/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
export default defineConfig({ server: { port: 5173 } });
```
Run `npm install`.

- [ ] **Step 2: Write the failing tests**

`apps/web/src/format.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatYear, polityLabel, tileUrl } from './format';

describe('formatYear', () => {
  it('formats AD and BC years', () => {
    expect(formatYear(1410)).toBe('1410');
    expect(formatYear(-500)).toBe('500 p.n.e.');
  });
});

describe('polityLabel', () => {
  it('translates the unnamed-territory sentinel and keeps other names', () => {
    expect(polityLabel('Unnamed territory')).toBe('Terytorium bez nazwy');
    expect(polityLabel('Teutonic Knights')).toBe('Teutonic Knights');
  });
});

describe('tileUrl', () => {
  it('builds a MapLibre tile template with the year', () => {
    expect(tileUrl('http://localhost:3000', 1400)).toBe(
      'http://localhost:3000/polities_tile/{z}/{x}/{y}?year=1400',
    );
  });
});
```
Run: `npm test -w apps/web` -> FAIL (module missing).

- [ ] **Step 3: Implement format.ts, api.ts, vite-env.d.ts**

`apps/web/src/vite-env.d.ts`: `/// <reference types="vite/client" />`

`apps/web/src/format.ts`:
```ts
export const UNNAMED = 'Unnamed territory';

export function formatYear(year: number): string {
  return year < 0 ? `${-year} p.n.e.` : String(year);
}

export function polityLabel(name: string): string {
  return name === UNNAMED ? 'Terytorium bez nazwy' : name;
}

export function tileUrl(base: string, year: number): string {
  return `${base}/polities_tile/{z}/{x}/{y}?year=${year}`;
}
```
`apps/web/src/api.ts`:
```ts
export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
export const TILES_URL: string = import.meta.env.VITE_TILES_URL ?? 'http://localhost:3000';

export interface PolityAt { id: number; name: string; subjecto: string | null; borderPrecision: number | null; color: string }
export interface AtResponse { year: number; snapshotYear: number | null; polities: PolityAt[] }
export interface Period { name: string; color: string; from: number; to: number | null }

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return (await res.json()) as T;
}

export const fetchSnapshots = () => getJson<{ years: number[] }>('/snapshots').then((r) => r.years);
export const fetchAt = (lat: number, lon: number, year: number) =>
  getJson<AtResponse>(`/at?lat=${lat}&lon=${lon}&year=${year}`);
export const fetchTimeline = (lat: number, lon: number) =>
  getJson<{ periods: Period[] }>(`/timeline?lat=${lat}&lon=${lon}`).then((r) => r.periods);
```
Run `npm test -w apps/web` -> 3 PASS.

- [ ] **Step 4: Panel, page and map**

`apps/web/index.html`:
```html
<!doctype html>
<html lang="pl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Historia Europy na mapie</title>
    <script type="module" src="/src/main.ts"></script>
  </head>
  <body>
    <div id="map"></div>
    <aside id="panel" hidden></aside>
    <footer id="controls">
      <label for="slider">Rok: <strong id="year-label"></strong></label>
      <input id="slider" type="range" min="0" max="0" step="1" value="0" />
    </footer>
  </body>
</html>
```
`apps/web/src/style.css`:
```css
html, body { margin: 0; height: 100%; font-family: system-ui, sans-serif; }
#map { position: absolute; inset: 0; }
#controls { position: absolute; left: 16px; right: 16px; bottom: 28px; padding: 8px 12px;
  background: rgba(255,255,255,.92); border-radius: 8px; display: flex; gap: 12px; align-items: center; }
#controls input { flex: 1; }
#panel { position: absolute; top: 16px; left: 16px; width: min(320px, calc(100% - 32px));
  max-height: 60%; overflow: auto; background: rgba(255,255,255,.95); border-radius: 8px;
  padding: 12px 16px; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
#panel h2 { font-size: 1rem; margin: 0 0 4px; }
#panel h3 { font-size: .85rem; margin: 12px 0 4px; color: #444; }
#panel ul { list-style: none; margin: 0; padding: 0; }
#panel li { display: flex; gap: 8px; align-items: center; padding: 2px 0; }
.swatch { width: 12px; height: 12px; border-radius: 2px; flex: none; border: 1px solid #0003; }
.muted { color: #666; font-size: .85rem; }
```
`apps/web/src/panel.ts` (uses `textContent` only):
```ts
import type { AtResponse, Period } from './api';
import { formatYear, polityLabel } from './format';

function item(color: string, text: string): HTMLLIElement {
  const li = document.createElement('li');
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = color;
  const label = document.createElement('span');
  label.textContent = text;
  li.append(swatch, label);
  return li;
}

function heading(tag: 'h2' | 'h3', text: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

export function renderPanel(el: HTMLElement, at: AtResponse, periods: Period[]): void {
  el.replaceChildren();
  el.hidden = false;

  el.append(heading('h2', `W roku ${formatYear(at.year)}`));
  if (at.snapshotYear !== null && at.snapshotYear !== at.year) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = `Najbliższa dostępna mapa: ${formatYear(at.snapshotYear)}`;
    el.append(note);
  }
  if (at.polities.length === 0) {
    const none = document.createElement('p');
    none.textContent = 'Brak danych dla tego miejsca w tym roku.';
    el.append(none);
  } else {
    const ul = document.createElement('ul');
    for (const p of at.polities) ul.append(item(p.color, polityLabel(p.name)));
    el.append(ul);
  }

  el.append(heading('h3', 'Historia tego miejsca'));
  const ul = document.createElement('ul');
  for (const p of periods) {
    const to = p.to === null ? 'dziś' : formatYear(p.to);
    ul.append(item(p.color, `${polityLabel(p.name)}: ${formatYear(p.from)} – ${to}`));
  }
  el.append(ul);
}
```
`apps/web/src/main.ts`:
```ts
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { TILES_URL, fetchAt, fetchSnapshots, fetchTimeline } from './api';
import { formatYear, tileUrl } from './format';
import { renderPanel } from './panel';

const params = new URLSearchParams(location.search);
const center: [number, number] = [Number(params.get('lng') ?? 12), Number(params.get('lat') ?? 50)];
const zoom = Number(params.get('zoom') ?? 3);

const map = document.getElementById('map') as HTMLElement;
const panel = document.getElementById('panel') as HTMLElement;
const slider = document.getElementById('slider') as HTMLInputElement;
const yearLabel = document.getElementById('year-label') as HTMLElement;

const years = await fetchSnapshots();
if (years.length === 0) {
  yearLabel.textContent = 'brak danych — uruchom import';
  throw new Error('No snapshots in the database');
}

slider.max = String(years.length - 1);
slider.value = String(years.length - 1);
const currentYear = () => years[Number(slider.value)];
const showYear = () => (yearLabel.textContent = formatYear(currentYear()));
showYear();

const source = 'polities';
const attribution =
  'Granice: <a href="https://github.com/aourednik/historical-basemaps">Historical Basemaps</a> (GPL-3.0)';

const mapInstance = new maplibregl.Map({
  container: map,
  center,
  zoom,
  style: {
    version: 8,
    projection: { type: 'globe' },
    sources: {
      [source]: { type: 'vector', tiles: [tileUrl(TILES_URL, currentYear())], minzoom: 0, maxzoom: 8, attribution },
    },
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': '#bcd7e6' } },
      {
        id: 'polity-fill', type: 'fill', source, 'source-layer': 'polities',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.85 },
      },
      {
        id: 'polity-line-precise', type: 'line', source, 'source-layer': 'polities',
        filter: ['!=', ['get', 'border_precision'], 1],
        paint: { 'line-color': '#444', 'line-width': 0.8 },
      },
      {
        id: 'polity-line-approx', type: 'line', source, 'source-layer': 'polities',
        filter: ['==', ['get', 'border_precision'], 1],
        paint: { 'line-color': '#444', 'line-width': 0.8, 'line-dasharray': [3, 2] },
      },
    ],
  },
});

slider.addEventListener('input', () => {
  showYear();
  (mapInstance.getSource(source) as maplibregl.VectorTileSource).setTiles([tileUrl(TILES_URL, currentYear())]);
});

mapInstance.on('click', async (e) => {
  const { lat, lng } = e.lngLat.wrap();
  try {
    const [at, periods] = await Promise.all([fetchAt(lat, lng, currentYear()), fetchTimeline(lat, lng)]);
    renderPanel(panel, at, periods);
  } catch {
    panel.hidden = false;
    panel.textContent = 'Nie udało się pobrać danych. Spróbuj kliknąć ponownie.';
  }
});
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build -w apps/web`
Expected: no type errors; Vite build succeeds. Fix any maplibre typing mismatches (e.g. the `projection` style key) against the installed `maplibre-gl` typings rather than casting to `any`.

- [ ] **Step 6: Manual verification in a browser**

```bash
docker compose up -d --wait db martin api
DATA_DIR=db/fixtures npm run import
npm run dev -w apps/web
```
Open `http://localhost:5173/?lat=45&lng=7&zoom=5`. Expected: globe with coloured squares; moving the slider swaps Kingdom A/B for two Kingdom B rectangles; clicking inside a square opens the panel with the polity and the timeline. Report honestly if anything differs.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: MapLibre globe frontend with year slider and click panel

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: E2E smoke test, CI, README

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/smoke.spec.ts`, `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: full stack from Tasks 1-6 seeded with `db/fixtures`.

- [ ] **Step 1: Playwright config and smoke test**

`apps/web/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
});
```
`apps/web/e2e/smoke.spec.ts` (requires the stack from Task 6 Step 6, seeded with fixtures):
```ts
import { expect, test } from '@playwright/test';

test('click shows the polity, slider changes the year', async ({ page }) => {
  await page.goto('/?lat=45&lng=2&zoom=5');
  const slider = page.locator('#slider');
  await expect(page.locator('#year-label')).toHaveText('1100');

  // 1100: lon 2 is inside Kingdom B (0..8)
  const canvas = page.locator('#map canvas');
  await canvas.click({ position: { x: (await canvas.boundingBox())!.width / 2, y: (await canvas.boundingBox())!.height / 2 } });
  await expect(page.locator('#panel')).toContainText('Kingdom B');

  // 1000: lon 2 is inside Kingdom A only
  await slider.fill('0');
  await expect(page.locator('#year-label')).toHaveText('1000');
  await canvas.click({ position: { x: (await canvas.boundingBox())!.width / 2, y: (await canvas.boundingBox())!.height / 2 } });
  await expect(page.locator('#panel')).toContainText('Kingdom A');
});
```
Run: `npx playwright install chromium && npx playwright test -c apps/web/playwright.config.ts` (with the stack up and fixtures imported).
Expected: 1 passed. If the map renders blank in headless Chromium (no WebGL), fix the launch args here rather than skipping the test; report if it cannot be made to run.

- [ ] **Step 2: CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      db:
        image: postgis/postgis:17-3.5
        env: { POSTGRES_PASSWORD: postgres, POSTGRES_DB: historicalmap }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres -h 127.0.0.1" --health-interval 3s --health-retries 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build -w apps/web
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: docker compose up -d --build --wait db martin api
      - run: DATA_DIR=db/fixtures npm run import
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test -c apps/web/playwright.config.ts
```

- [ ] **Step 3: README**

`README.md` must contain, in Polish: what the project is; a screenshot placeholder is NOT allowed — omit screenshots; quick start (`docker compose up -d`, `scripts/fetch-data.sh`, `npm run import`, `npm run dev -w apps/web`); how to run tests (`npm test`, needs `docker compose up -d --wait db`); architecture in one paragraph (PostGIS -> Martin tiles + Fastify API -> MapLibre globe); data section: "Granice pochodzą z [Historical Basemaps](https://github.com/aourednik/historical-basemaps) (GPL-3.0), autor: Andrew Ourednik; są przybliżone i mają charakter edukacyjny"; license GPL-3.0.

- [ ] **Step 4: Full verification and commit**

Run: `npm run typecheck && npm test && npm run build -w apps/web`
Expected: all green.
```bash
git add -A && git commit -m "feat: e2e smoke test, CI and README

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** globe + click + year slider + per-polity colours (Tasks 3, 6); timeline panel (Tasks 4, 6); PostGIS + Martin tiles (Tasks 1, 3, 5); API endpoints and validation (Task 4); idempotent transactional import, Europe filter, source not in repo, attribution (Tasks 2, 6, 7); tests per spec (Tasks 1-4 integration, 6 unit, 7 Playwright); CI (Task 7); GPL-3.0 (already committed). Out-of-scope items (ads, OHM, search, accounts, i18n) are not planned.
- **Deviations from spec, all listed under "Decisions":** `/snapshots` endpoint added, unnamed-territory sentinel, latitude clip, `MIN_YEAR` default 1, colour computed in SQL, frontend "lint" is typecheck.
- **Type consistency:** `Period`/`TimelineRow` (Task 4) match `api.ts` `Period` (Task 6); tile properties `id, name, color, border_precision` (Task 3) match the style expressions (Task 6); `UNNAMED` is defined in the importer and mirrored in `format.ts` and SQL (`'Unnamed territory'`) — three places, covered by tests in Tasks 2, 3, 4.
- **Known risks to check while executing:** Martin function discovery and catalog name (Task 5 Step 3); maplibre `projection` style key under the installed version (Task 6 Step 5); headless WebGL for Playwright (Task 7 Step 1).
