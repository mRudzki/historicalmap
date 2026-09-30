import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_DIR, clearAll, testPool } from '../db/test-support';
import { UNNAMED, importDirectory, parseSnapshotYear } from './import-lib';
import { importLand } from './import-land-lib';

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

    const years = await pool.query('SELECT DISTINCT valid_from::int AS year FROM polity_geometries ORDER BY 1');
    expect(years.rows.map((r) => r.year)).toEqual([1000, 1100]);
  });

  it('honours minYear and stores BC years as negatives', async () => {
    const result = await importDirectory(pool, FIXTURE_DIR, { minYear: -1000 });
    expect(result.snapshots).toBe(3);
    const years = await pool.query('SELECT DISTINCT valid_from::int AS year FROM polity_geometries ORDER BY 1');
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

  it('accepts 3D coordinates (real Historical Basemaps data has a Z value)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hm-'));
    const zdata = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { NAME: 'Z Land', BORDERPRECISION: 1 },
          geometry: { type: 'MultiPolygon', coordinates: [[[[0, 40, 0], [10, 40, 0], [10, 50, 0], [0, 50, 0], [0, 40, 0]]]] },
        },
      ],
    };
    await writeFile(path.join(dir, 'world_1500.geojson'), JSON.stringify(zdata));
    const result = await importDirectory(pool, dir);
    expect(result.features).toBe(1);
  });

  it('refuses to import (and keeps existing data) when no snapshot files match', async () => {
    await importDirectory(pool, FIXTURE_DIR);
    const empty = await mkdtemp(path.join(os.tmpdir(), 'hm-'));
    await expect(importDirectory(pool, empty)).rejects.toThrow(/no snapshot files/i);
    await expect(importDirectory(pool, FIXTURE_DIR, { minYear: Number.NaN })).rejects.toThrow(/minYear/);
    const count = await pool.query('SELECT count(*)::int AS n FROM polity_geometries');
    expect(count.rows[0].n).toBe(5);
  });

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

  it('stores valid simplified copies (tiles and point lookups) of every geometry', async () => {
    await importDirectory(pool, FIXTURE_DIR);
    const r = await pool.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE geom_simple IS NULL OR NOT ST_IsValid(geom_simple)
                                 OR ST_NPoints(geom_simple) > ST_NPoints(geom)
                                 OR geom_lookup IS NULL OR NOT ST_IsValid(geom_lookup)
                                 OR ST_NPoints(geom_lookup) > ST_NPoints(geom))::int AS bad
       FROM polity_geometries`,
    );
    expect(r.rows[0]).toEqual({ n: 5, bad: 0 });
  });

  it('clips geometries to the land when land is loaded and drops polygons that are entirely at sea', async () => {
    await importLand(pool, path.join(FIXTURE_DIR, 'land', 'land.geojson'));
    const result = await importDirectory(pool, FIXTURE_DIR);
    expect(result.features).toBe(4); // Unnamed territory (20..25) lies in the sea; the others keep a land part
    const areas = await pool.query(
      `SELECT p.name, g.valid_from, round(ST_Area(g.geom)::numeric) AS area, round(ST_Area(g.geom_simple)::numeric) AS area_simple
       FROM polity_geometries g JOIN polities p ON p.id = g.polity_id ORDER BY g.valid_from, p.name, area`,
    );
    expect(areas.rows).toEqual([
      { name: 'Kingdom A', valid_from: 1000, area: '70', area_simple: '70' }, // 5*10 + 4*5
      { name: 'Kingdom B', valid_from: 1000, area: '20', area_simple: '20' }, // only lon 6..10 x lat 40..45
      { name: 'Kingdom B', valid_from: 1100, area: '10', area_simple: '10' }, // lon 8..10 x lat 40..45
      { name: 'Kingdom B', valid_from: 1100, area: '60', area_simple: '60' }, // 5*10 + 2*5
    ]);
    const gone = await pool.query("SELECT 1 FROM polities WHERE name = 'Unnamed territory'");
    expect(gone.rowCount).toBe(0);
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

  it('rolls back completely when a file is broken', async () => {
    await importDirectory(pool, FIXTURE_DIR);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hm-'));
    await writeFile(path.join(dir, 'world_1500.geojson'), '{ not json');
    await expect(importDirectory(pool, dir)).rejects.toThrow();
    const count = await pool.query('SELECT count(*)::int AS n FROM polity_geometries');
    expect(count.rows[0].n).toBe(5); // previous data untouched
  });
});
