import pg from 'pg';
import { applySchema } from '../db/apply-schema';
import { importDirectory, parseBbox } from './import-lib';
import { ensureLand } from './land-cli';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/historicalmap';
const dir = process.env.DATA_DIR ?? 'data/historical-basemaps/geojson';
const minYear = process.env.MIN_YEAR ? Number(process.env.MIN_YEAR) : undefined;
const bbox = process.env.BBOX ? parseBbox(process.env.BBOX) : undefined;

const pool = new pg.Pool({ connectionString: url });
try {
  await applySchema(pool);
  await ensureLand(pool);
  const result = await importDirectory(pool, dir, { minYear, bbox });
  console.log(`Imported ${result.features} features in ${result.snapshots} snapshots from ${dir}`);
} finally {
  await pool.end();
}
