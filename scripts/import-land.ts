import pg from 'pg';
import { applySchema } from '../db/apply-schema';
import { clipExisting } from './import-land-lib';
import { loadLand } from './land-cli';

// npm run import:land          loads the land mask (Natural Earth)
// npm run clip                 loads it and clips the geometries that are already in the database
const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/historicalmap';
const pool = new pg.Pool({ connectionString: url });
try {
  await applySchema(pool);
  await loadLand(pool);
  if (process.argv.includes('--clip')) {
    const { removed } = await clipExisting(pool);
    console.log(`Clipped existing geometries to the land (${removed} lying entirely at sea removed)`);
  }
} finally {
  await pool.end();
}
