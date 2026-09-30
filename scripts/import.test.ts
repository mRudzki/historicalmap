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

  it('rolls back completely when a file is broken', async () => {
    await importDirectory(pool, FIXTURE_DIR);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hm-'));
    await writeFile(path.join(dir, 'world_1500.geojson'), '{ not json');
    await expect(importDirectory(pool, dir)).rejects.toThrow();
    const count = await pool.query('SELECT count(*)::int AS n FROM polity_geometries');
    expect(count.rows[0].n).toBe(5); // previous data untouched
  });
});
