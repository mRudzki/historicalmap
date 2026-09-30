import pg from 'pg';
import { ADMIN_URL, TEST_DB, TEST_URL, applySchema } from './test-support';

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: TEST_URL });
  await applySchema(pool);
  await pool.end();
}
