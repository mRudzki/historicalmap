import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearAll, seedFixture, seedOhmFixture, testPool } from './test-support';

const pool = testPool();

beforeAll(async () => {
  await clearAll(pool);
  await seedFixture(pool);
  await seedOhmFixture(pool);
});
afterAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS ohm_stage CASCADE');
  await pool.end();
});

async function tile(z: number, x: number, y: number, params: Record<string, string>) {
  const { rows } = await pool.query('SELECT polities_tile($1,$2,$3,$4::json) AS t', [
    z, x, y, JSON.stringify(params),
  ]);
  return rows[0].t as Buffer;
}

function decode(buf: Buffer, layerName: string) {
  const layer = new VectorTile(new PbfReader(buf)).layers[layerName];
  if (!layer) return [];
  return Array.from({ length: layer.length }, (_, i) => layer.feature(i).properties);
}
const namesIn = (buf: Buffer, layer: string) => decode(buf, layer).map((f) => f.name).sort();

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
  it('fallback holds HB, polities holds OHM level 2, regions holds OHM levels 3-4', async () => {
    const t = await tile(0, 0, 0, { year: '1060' });
    expect(namesIn(t, 'fallback')).toEqual(['Far Empire', 'Kingdom A', 'Kingdom B', 'Unnamed territory']);
    expect(namesIn(t, 'polities')).toEqual(['Far Realm', 'Licensed Land', 'Realm X']);
    expect(namesIn(t, 'regions')).toEqual(['Region R']);
  });

  it('follows the year: OHM features appear and disappear at their dates', async () => {
    expect(namesIn(await tile(0, 0, 0, { year: '1000' }), 'polities')).toEqual(['Far Realm', 'Licensed Land']);
    const later = await tile(0, 0, 0, { year: '1500' });
    expect(namesIn(later, 'polities')).toEqual(['Far Realm', 'Licensed Land', 'Reich ohne Englisch']);
    expect(namesIn(later, 'regions')).toEqual([]);
    expect(namesIn(later, 'fallback')).toEqual(['Kingdom B', 'Kingdom B']);
  });

  it('exposes id, name, color, level and border_precision', async () => {
    const t = await tile(0, 0, 0, { year: '1060' });
    const a = decode(t, 'fallback').find((f) => f.name === 'Kingdom A');
    expect(a).toMatchObject({ name: 'Kingdom A', level: 2, border_precision: 2 });
    expect(a?.color).toMatch(/^hsl\(/);
    expect(decode(t, 'regions')[0]).toMatchObject({ name: 'Region R', level: 4 });
  });

  it('uses lighter geometry at low zoom (simple up to z5, lookup at z6-7) and the full one from z8', async () => {
    await pool.query("INSERT INTO polities (name, admin_level) VALUES ('Circle Land', 2)");
    await pool.query(
      `INSERT INTO polity_geometries (polity_id, source, valid_from, geom, geom_simple, geom_lookup)
       SELECT p.id, 'ohm', 1500, g.geom, simplify_polygons(g.geom), simplify_lookup(g.geom)
       FROM polities p,
            LATERAL (SELECT ST_Multi(ST_Buffer(ST_SetSRID(ST_MakePoint(20.5, 43.0), 4326), 0.2, 'quad_segs=200')) AS geom) g
       WHERE p.name = 'Circle Land'`,
    );
    const tileFor = (z: number, lon: number, lat: number) => {
      const n = 2 ** z;
      const rad = (lat * Math.PI) / 180;
      return {
        x: Math.floor(((lon + 180) / 360) * n),
        y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
      };
    };
    const vertices = async (z: number) => {
      const { x, y } = tileFor(z, 20.5, 43.0);
      const layer = new VectorTile(new PbfReader(await tile(z, x, y, { year: '1500' }))).layers.polities;
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        if (f.properties.name === 'Circle Land') return f.loadGeometry().reduce((n, ring) => n + ring.length, 0);
      }
      throw new Error('Circle Land not found in the tile');
    };
    try {
      const full = await vertices(8);
      expect(await vertices(4)).toBeLessThan(full / 5);
      expect(await vertices(6)).toBeLessThan(full / 5);
    } finally {
      await pool.query("DELETE FROM polities WHERE name = 'Circle Land'");
    }
  });

  it('returns an empty tile where there is no data', async () => {
    expect((await tile(4, 0, 0, { year: '1000' })).length).toBe(0);
  });

  it.each([
    ['missing year', {}],
    ['non-numeric year', { year: 'abc' }],
    ['year before any data', { year: '999' }],
  ])('returns an empty tile for %s, not an error', async (_label, params) => {
    expect((await tile(0, 0, 0, params)).length).toBe(0);
  });
});
