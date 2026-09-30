import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema } from './apply-schema';
import { clearAll, testPool } from './test-support';

const pool = testPool();
beforeEach(() => clearAll(pool));
afterAll(() => pool.end());

const sq = "ST_Multi(ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))',4326))";

describe('schema', () => {
  it('rejects two polities with the same name and level, allows the same name at another level', async () => {
    await pool.query("INSERT INTO polities (name, admin_level) VALUES ('Baden', 2)");
    await expect(pool.query("INSERT INTO polities (name, admin_level) VALUES ('Baden', 2)")).rejects.toThrow(/unique/i);
    await pool.query("INSERT INTO polities (name, admin_level) VALUES ('Baden', 4)");
  });

  it('rejects a non-MultiPolygon geometry', async () => {
    await pool.query("INSERT INTO polities (name) VALUES ('P')");
    await expect(
      pool.query("INSERT INTO polity_geometries (polity_id, source, valid_from, geom) VALUES (1, 'hb', 1000, ST_SetSRID(ST_MakePoint(1,1),4326))"),
    ).rejects.toThrow();
  });

  it('rejects an unknown source and an interval that ends before it starts', async () => {
    await pool.query("INSERT INTO polities (name) VALUES ('P')");
    await expect(
      pool.query(`INSERT INTO polity_geometries (polity_id, source, valid_from, geom) VALUES (1, 'xyz', 1000, ${sq})`),
    ).rejects.toThrow();
    await expect(
      pool.query(`INSERT INTO polity_geometries (polity_id, source, valid_from, valid_to, geom) VALUES (1, 'hb', 1000, 900, ${sq})`),
    ).rejects.toThrow();
  });

  it('refuses to run on the old snapshot-based schema without dropping anything', async () => {
    await pool.query('CREATE TABLE snapshots (id int)');
    try {
      await expect(applySchema(pool)).rejects.toThrow(/docker compose down -v/);
    } finally {
      await pool.query('DROP TABLE snapshots');
    }
  });
});
