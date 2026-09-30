import pg from 'pg';
import { ADMIN_URL, TEST_DB, TEST_URL, applySchema } from './test-support';

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: TEST_URL });
  await applySchema(pool);
  await pool.end();
}
