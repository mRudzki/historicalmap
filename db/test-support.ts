import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { importDirectory } from '../scripts/import-lib';
export { applySchema } from './apply-schema';

export const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';
export const TEST_DB = 'historicalmap_test';
export const TEST_URL =
  process.env.TEST_DATABASE_URL ?? `postgres://postgres:postgres@localhost:5433/${TEST_DB}`;

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(here, 'fixtures');

export function testPool(): pg.Pool {
  return new pg.Pool({ connectionString: TEST_URL });
}

export async function clearAll(pool: pg.Pool): Promise<void> {
  await pool.query(
    'TRUNCATE polity_geometries, polities RESTART IDENTITY CASCADE',
  );
}

export async function seedFixture(pool: pg.Pool): Promise<void> {
  await importDirectory(pool, FIXTURE_DIR);
}
