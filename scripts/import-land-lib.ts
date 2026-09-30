import { readFile } from 'node:fs/promises';
import type pg from 'pg';

// Loads a land mask (GeoJSON, e.g. Natural Earth ne_10m_land) into the `land` table, subdivided into
// small pieces so that clip_to_land stays fast. Replaces the previous mask in one transaction.
export async function importLand(pool: pg.Pool, file: string): Promise<{ pieces: number }> {
  const json = JSON.parse(await readFile(file, 'utf8')) as { features: { geometry: unknown }[] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM land');
    for (const feature of json.features) {
      await client.query(
        `INSERT INTO land (geom)
         SELECT ST_Subdivide(ST_CollectionExtract(ST_MakeValid(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326))), 3), 256)`,
        [JSON.stringify(feature.geometry)],
      );
    }
    const { rows } = await client.query('SELECT count(*)::int AS n FROM land');
    await client.query('COMMIT');
    return { pieces: rows[0].n as number };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Applies the land mask to geometries that were imported before it was loaded: clips them,
// refreshes the simplified copies and removes geometries that lie entirely at sea.
export async function clipExisting(pool: pg.Pool): Promise<{ removed: number }> {
  const land = await pool.query('SELECT count(*)::int AS n FROM land');
  if (land.rows[0].n === 0) throw new Error('The land table is empty: load the land mask first (npm run import:land).');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE polity_geometries SET geom = ST_Multi(ST_CollectionExtract(clip_to_land(geom), 3))');
    const removed = await client.query('DELETE FROM polity_geometries WHERE ST_IsEmpty(geom)');
    await client.query('UPDATE polity_geometries SET geom_simple = simplify_polygons(geom), geom_lookup = simplify_lookup(geom)');
    await client.query(
      'DELETE FROM polities p WHERE NOT EXISTS (SELECT 1 FROM polity_geometries g WHERE g.polity_id = p.id)',
    );
    await client.query('COMMIT');
    return { removed: removed.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
