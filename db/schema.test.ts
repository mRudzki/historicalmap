import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearAll, testPool } from './test-support';

const pool = testPool();
beforeEach(() => clearAll(pool));
afterAll(() => pool.end());

describe('schema', () => {
  it('rejects two polities with the same name', async () => {
    await pool.query("INSERT INTO polities (name) VALUES ('Kingdom A')");
    await expect(pool.query("INSERT INTO polities (name) VALUES ('Kingdom A')")).rejects.toThrow(
      /unique/i,
    );
  });

  it('rejects a non-MultiPolygon geometry', async () => {
    await pool.query("INSERT INTO polities (name) VALUES ('P')");
    await pool.query('INSERT INTO snapshots (year) VALUES (1000)');
    await expect(
      pool.query(
        'INSERT INTO polity_geometries (polity_id, snapshot_id, geom) VALUES (1, 1, ST_SetSRID(ST_MakePoint(1,1),4326))',
      ),
    ).rejects.toThrow();
  });
});
