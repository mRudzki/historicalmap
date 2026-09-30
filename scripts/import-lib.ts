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
  properties: { NAME?: string | null; BORDERPRECISION?: number | null };
  geometry: unknown;
}

// One statement per feature: build a valid, clipped MultiPolygon, keep it only if it
// touches Europe, upsert the polity, insert the geometry. rowCount = 1 when kept.
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
INSERT INTO polity_geometries (polity_id, source, valid_from, valid_to, geom, geom_simple, border_precision)
SELECT p.id, 'hb', $7::float8, $8::float8, keep.geom, simplify_polygons(keep.geom), $9::smallint FROM p, keep`;

export async function importDirectory(
  pool: pg.Pool,
  dir: string,
  opts: { minYear?: number } = {},
): Promise<{ snapshots: number; features: number }> {
  const minYear = opts.minYear ?? 1;
  if (!Number.isFinite(minYear)) throw new Error(`Invalid minYear: ${opts.minYear}`);
  const files = (await readdir(dir))
    .map((name) => ({ name, year: parseSnapshotYear(name) }))
    .filter((f): f is { name: string; year: number } => f.year !== null && f.year >= minYear)
    .sort((a, b) => a.year - b.year);

  if (files.length === 0) throw new Error(`No snapshot files (world_<year>.geojson) found in ${dir}`);

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
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { snapshots: parsed.length, features };
}
