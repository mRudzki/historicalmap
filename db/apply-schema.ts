import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));

// Idempotent: safe to run on an existing database (initdb.d only runs on first init).
export async function applySchema(pool: pg.Pool): Promise<void> {
  for (const file of ['01-schema.sql', '02-functions.sql']) {
    await pool.query(await readFile(path.join(here, file), 'utf8'));
  }
}
