import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));

// Idempotent: safe to run on an existing database (initdb.d only runs on first init).
// Never drops data: an old snapshot-based database must be recreated by the user.
export async function applySchema(pool: pg.Pool): Promise<void> {
  const old = await pool.query("SELECT to_regclass('public.snapshots') IS NOT NULL AS old");
  if (old.rows[0].old) {
    throw new Error(
      'Old snapshot-based schema detected. Run "docker compose down -v" and re-import (the data is reproducible from its sources).',
    );
  }
  for (const file of ['01-schema.sql', '02-functions.sql']) {
    await pool.query(await readFile(path.join(here, file), 'utf8'));
  }
}
