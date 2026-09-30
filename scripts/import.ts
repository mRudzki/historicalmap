import pg from 'pg';
import { applySchema } from '../db/apply-schema';
import { importDirectory } from './import-lib';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/historicalmap';
const dir = process.env.DATA_DIR ?? 'data/historical-basemaps/geojson';
const minYear = process.env.MIN_YEAR ? Number(process.env.MIN_YEAR) : undefined;

const pool = new pg.Pool({ connectionString: url });
try {
  await applySchema(pool);
  const result = await importDirectory(pool, dir, { minYear });
  console.log(`Imported ${result.features} features in ${result.snapshots} snapshots from ${dir}`);
} finally {
  await pool.end();
}
