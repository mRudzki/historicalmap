import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_DIR, clearAll, seedFixture, testPool } from '../db/test-support';
import { importLand } from './import-land-lib';
import { importOhmStaging } from './import-ohm-lib';
import { parseBbox } from './import-lib';

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
    expect(result).toEqual({ imported: 5, skippedDate: 2, skippedLicense: 1, skippedOld: 0 });
    expect((await ohmRows()).rows).toEqual([
      { name: 'Far Realm', admin_level: 2, valid_from: 1000, valid_to: null }, // far away, default world bbox
      { name: 'Licensed Land', admin_level: 2, valid_from: 1000, valid_to: null },
      { name: 'Realm X', admin_level: 2, valid_from: 1050, valid_to: 1081 }, // name:en wins; end "1080" is end of 1080
      { name: 'Region R', admin_level: 4, valid_from: 1060, valid_to: 1071 },
      { name: 'Reich ohne Englisch', admin_level: 2, valid_from: 1200, valid_to: null }, // falls back to name
    ]);
  });

  it('honours bbox: rows outside the box are never read from staging', async () => {
    await importOhmStaging(pool, { bbox: parseBbox('-25,34,45,72') });
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
    expect((await ohmRows()).rowCount).toBe(5);
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

  it('stores a valid simplified copy of every geometry', async () => {
    await importOhmStaging(pool);
    const r = await pool.query(
      `SELECT count(*) FILTER (WHERE geom_simple IS NULL OR NOT ST_IsValid(geom_simple)
                                 OR ST_NPoints(geom_simple) > ST_NPoints(geom)
                                 OR geom_lookup IS NULL OR NOT ST_IsValid(geom_lookup)
                                 OR ST_NPoints(geom_lookup) > ST_NPoints(geom))::int AS bad
       FROM polity_geometries WHERE source = 'ohm'`,
    );
    expect(r.rows[0].bad).toBe(0);
  });

  it('clips to the land when land is loaded and drops polygons entirely at sea', async () => {
    await importLand(pool, path.join(FIXTURE_DIR, 'land', 'land.geojson'));
    const result = await importOhmStaging(pool);
    expect(result.imported).toBe(3); // Licensed Land (30..35) and Reich ohne Englisch (36..40) are in the sea
    const r = await pool.query(
      `SELECT p.name, round(ST_Area(g.geom)::numeric) AS area
       FROM polity_geometries g JOIN polities p ON p.id = g.polity_id WHERE g.source = 'ohm' ORDER BY p.name`,
    );
    expect(r.rows).toEqual([
      { name: 'Far Realm', area: '100' }, // its land box (lon 100..110)
      { name: 'Realm X', area: '70' },
      { name: 'Region R', area: '25' }, // lon 0..5 x lat 40..45, fully on land
    ]);
  });

  it('aborts and changes nothing when the staging table is missing', async () => {
    await importOhmStaging(pool);
    await pool.query('DROP SCHEMA ohm_stage CASCADE');
    await expect(importOhmStaging(pool)).rejects.toThrow();
    expect((await ohmRows()).rowCount).toBe(5);
  });
});
