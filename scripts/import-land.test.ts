import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_DIR, clearAll, testPool } from '../db/test-support';
import { clipExisting, importLand } from './import-land-lib';
import { importDirectory } from './import-lib';

const pool = testPool();
const LAND = path.join(FIXTURE_DIR, 'land', 'land.geojson');

beforeEach(() => clearAll(pool));
afterAll(() => pool.end());

describe('importLand', () => {
  it('loads polygons (Polygon and MultiPolygon features) as valid pieces', async () => {
    const { pieces } = await importLand(pool, LAND);
    expect(pieces).toBe(3); // 1 polygon + 2 multipolygon parts, all small enough not to be split
    const r = await pool.query(
      'SELECT count(*)::int AS n, bool_and(ST_IsValid(geom)) AS ok, round(sum(ST_Area(geom))::numeric) AS area FROM land',
    );
    expect(r.rows[0]).toEqual({ n: 3, ok: true, area: '170' }); // 5*10 + 4*5 + 10*10
  });

  it('is idempotent', async () => {
    await importLand(pool, LAND);
    await importLand(pool, LAND);
    const r = await pool.query('SELECT count(*)::int AS n FROM land');
    expect(r.rows[0].n).toBe(3);
  });

  it('keeps the existing land when the file is broken', async () => {
    await importLand(pool, LAND);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hm-land-'));
    const broken = path.join(dir, 'broken.geojson');
    await writeFile(broken, '{ not json');
    await expect(importLand(pool, broken)).rejects.toThrow();
    const r = await pool.query('SELECT count(*)::int AS n FROM land');
    expect(r.rows[0].n).toBe(3);
  });
});

describe('clip_to_land', () => {
  it('returns the geometry unchanged while the land table is empty', async () => {
    const r = await pool.query(
      "SELECT ST_Area(clip_to_land(ST_GeomFromText('POLYGON((0 40,10 40,10 50,0 50,0 40))', 4326))) AS a",
    );
    expect(r.rows[0].a).toBe(100);
  });

  it('keeps only the part on land and returns an empty geometry for a polygon entirely at sea', async () => {
    await importLand(pool, LAND);
    const r = await pool.query(
      `SELECT ST_Area(clip_to_land(ST_GeomFromText('POLYGON((0 40,10 40,10 50,0 50,0 40))', 4326))) AS land_part,
              ST_IsEmpty(clip_to_land(ST_GeomFromText('POLYGON((20 40,25 40,25 45,20 45,20 40))', 4326))) AS sea_only`,
    );
    expect(r.rows[0]).toEqual({ land_part: 70, sea_only: true }); // 5*10 + 4*5
  });
});

describe('clipExisting', () => {
  it('refuses to run while no land is loaded', async () => {
    await expect(clipExisting(pool)).rejects.toThrow(/land/i);
  });

  it('clips already imported geometries, refreshes the simplified copy and removes what lies at sea', async () => {
    await importDirectory(pool, FIXTURE_DIR); // imported without land: nothing is clipped yet
    const before = await pool.query('SELECT count(*)::int AS n FROM polity_geometries');
    expect(before.rows[0].n).toBe(6);

    await importLand(pool, LAND);
    const result = await clipExisting(pool);
    expect(result).toEqual({ removed: 1 }); // Unnamed territory (20..25) is entirely at sea

    const rows = await pool.query(
      `SELECT p.name, g.valid_from, round(ST_Area(g.geom)::numeric) AS area, round(ST_Area(g.geom_simple)::numeric) AS area_simple, round(ST_Area(g.geom_lookup)::numeric) AS area_lookup
       FROM polity_geometries g JOIN polities p ON p.id = g.polity_id ORDER BY g.valid_from, p.name, area`,
    );
    expect(rows.rows).toEqual([
      { name: 'Far Empire', valid_from: 1000, area: '100', area_simple: '100', area_lookup: '100' },
      { name: 'Kingdom A', valid_from: 1000, area: '70', area_simple: '70', area_lookup: '70' },
      { name: 'Kingdom B', valid_from: 1000, area: '20', area_simple: '20', area_lookup: '20' },
      { name: 'Kingdom B', valid_from: 1100, area: '10', area_simple: '10', area_lookup: '10' },
      { name: 'Kingdom B', valid_from: 1100, area: '60', area_simple: '60', area_lookup: '60' },
    ]);
    expect((await pool.query("SELECT 1 FROM polities WHERE name = 'Unnamed territory'")).rowCount).toBe(0);
  });

  it('is idempotent', async () => {
    await importDirectory(pool, FIXTURE_DIR);
    await importLand(pool, LAND);
    await clipExisting(pool);
    expect(await clipExisting(pool)).toEqual({ removed: 0 });
  });
});
