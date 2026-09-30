import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearAll, seedFixture, testPool } from './test-support';

const pool = testPool();

beforeAll(async () => {
  await clearAll(pool);
  await seedFixture(pool);
});
afterAll(() => pool.end());

async function tile(z: number, x: number, y: number, params: Record<string, string>) {
  const { rows } = await pool.query('SELECT polities_tile($1,$2,$3,$4::json) AS t', [
    z, x, y, JSON.stringify(params),
  ]);
  return rows[0].t as Buffer;
}

function decode(buf: Buffer) {
  const layer = new VectorTile(new PbfReader(buf)).layers.polities;
  if (!layer) return [];
  return Array.from({ length: layer.length }, (_, i) => layer.feature(i).properties);
}

describe('snapshot_for_year', () => {
  it('floors to the newest snapshot not after the year, else NULL', async () => {
    const q = (y: number) => pool.query('SELECT s.year FROM snapshots s WHERE s.id = snapshot_for_year($1)', [y]);
    expect((await q(1000)).rows[0].year).toBe(1000);
    expect((await q(1099)).rows[0].year).toBe(1000);
    expect((await q(1500)).rows[0].year).toBe(1100);
    expect((await q(999)).rowCount).toBe(0);
  });
});

describe('polity_color', () => {
  it('is stable, an hsl string, and grey for the unnamed sentinel', async () => {
    const { rows } = await pool.query(
      "SELECT polity_color('Kingdom A') AS a, polity_color('Kingdom A') AS a2, polity_color('Unnamed territory') AS u",
    );
    expect(rows[0].a).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
    expect(rows[0].a).toBe(rows[0].a2);
    expect(rows[0].u).toBe('hsl(0, 0%, 80%)');
  });
});

describe('polities_tile', () => {
  it('returns the polities of the snapshot for the requested year', async () => {
    const names = decode(await tile(0, 0, 0, { year: '1000' })).map((f) => f.name).sort();
    expect(names).toEqual(['Kingdom A', 'Kingdom B', 'Unnamed territory']);
    const later = decode(await tile(0, 0, 0, { year: '1100' })).map((f) => f.name);
    expect(later).toEqual(['Kingdom B', 'Kingdom B']);
  });

  it('exposes id, name, color and border_precision', async () => {
    const a = decode(await tile(0, 0, 0, { year: '1000' })).find((f) => f.name === 'Kingdom A');
    expect(a).toMatchObject({ name: 'Kingdom A', border_precision: 2 });
    expect(a?.color).toMatch(/^hsl\(/);
    expect(a?.id).toBeTypeOf('number');
  });

  it('returns an empty tile where there is no data', async () => {
    expect((await tile(4, 0, 0, { year: '1000' })).length).toBe(0);
  });

  it.each([
    ['missing year', {}],
    ['non-numeric year', { year: 'abc' }],
    ['year before first snapshot', { year: '999' }],
  ])('returns an empty tile for %s, not an error', async (_label, params) => {
    expect((await tile(0, 0, 0, params)).length).toBe(0);
  });
});
