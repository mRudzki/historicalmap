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
