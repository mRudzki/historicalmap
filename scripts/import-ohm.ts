import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import pg from 'pg';
import { applySchema } from '../db/apply-schema';
import { importOhmStaging } from './import-ohm-lib';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/historicalmap';
const minYear = process.env.MIN_YEAR ? Number(process.env.MIN_YEAR) : undefined;
const skipLoad = process.env.OHM_SKIP_LOAD === '1'; // use an existing ohm_stage schema (tests/e2e)

const pool = new pg.Pool({ connectionString: url });
try {
  await applySchema(pool);
  if (!skipLoad) {
    execFileSync('scripts/fetch-ohm.sh', { stdio: 'inherit' });
    await pool.query('DROP SCHEMA IF EXISTS ohm_stage CASCADE; CREATE SCHEMA ohm_stage;');
    // No --bbox: it cuts relation members outside the box and breaks ring assembly.
    execFileSync(
      'docker',
      ['compose', '--profile', 'tools', 'run', '--rm', 'osm2pgsql', 'osm2pgsql',
        '-H', 'db', '-U', 'postgres', '-d', 'historicalmap',
        '--slim', '--flat-nodes', '/data/nodes.bin',
        '--schema=ohm_stage', '--middle-schema=ohm_stage', '--log-progress=false',
        '-O', 'flex', '-S', '/db/ohm.lua', '/data/planet.osm.pbf'],
      { stdio: 'inherit' },
    );
  }
  const r = await importOhmStaging(pool, { minYear });
  console.log(
    `OHM: imported ${r.imported}, skipped ${r.skippedDate} (bad date / no name), ${r.skippedLicense} (share-alike licence), ${r.skippedOld} (before MIN_YEAR)`,
  );
  await pool.query('DROP SCHEMA IF EXISTS ohm_stage CASCADE');
  if (!skipLoad) rmSync('data/ohm/nodes.bin', { force: true });
} finally {
  await pool.end();
}
