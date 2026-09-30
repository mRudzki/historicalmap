import { execFileSync } from 'node:child_process';
import type pg from 'pg';
import { importLand } from './import-land-lib';

export const LAND_FILE = process.env.LAND_FILE ?? 'data/land/ne_10m_land.geojson';

// Loads the land mask when the table is empty (no-op with SKIP_LAND=1, used for the e2e fixtures).
export async function ensureLand(pool: pg.Pool): Promise<void> {
  if (process.env.SKIP_LAND === '1') return;
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM land');
  if (rows[0].n > 0) return;
  await loadLand(pool);
}

export async function loadLand(pool: pg.Pool): Promise<void> {
  if (!process.env.LAND_FILE) execFileSync('scripts/fetch-land.sh', { stdio: 'inherit' });
  const { pieces } = await importLand(pool, LAND_FILE);
  console.log(`Land mask: ${pieces} pieces loaded from ${LAND_FILE}`);
}
