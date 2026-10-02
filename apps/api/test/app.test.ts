import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearAll, seedFixture, seedOhmFixture, testPool } from '../../../db/test-support';
import { createApp } from '../src/app';

const pool = testPool();
const app = createApp(pool);
const thisYear = new Date().getFullYear();

const get = (url: string) => app.inject({ method: 'GET', url });
const names = (body: string, key = 'polities') =>
  JSON.parse(body)[key].map((p: { name: string }) => p.name).sort();

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('HB data only', () => {
  beforeAll(async () => {
    await clearAll(pool);
    await seedFixture(pool);
  });

  it('GET /range spans the earliest interval to the current year', async () => {
    expect((await get('/range')).json()).toEqual({ min: 1000, max: thisYear });
  });

  describe('GET /at', () => {
    it('returns the polity at a point, marked as HB', async () => {
      const res = await get('/at?lat=45&lon=2&year=1000');
      expect(res.statusCode).toBe(200);
      expect(res.json().year).toBe(1000);
      expect(res.json().polities).toEqual([
        expect.objectContaining({ name: 'Kingdom A', adminLevel: 2, source: 'hb' }),
      ]);
      expect(res.json().regions).toEqual([]);
    });

    it('returns every overlapping polity', async () => {
      expect(names((await get('/at?lat=45&lon=7&year=1000')).body)).toEqual(['Kingdom A', 'Kingdom B']);
    });

    it('a year between two HB snapshots uses the earlier snapshot', async () => {
      expect(names((await get('/at?lat=45&lon=7&year=1050')).body)).toEqual(['Kingdom A', 'Kingdom B']);
    });

    it('the last HB snapshot stays valid up to the present', async () => {
      expect(names((await get(`/at?lat=45&lon=8&year=${thisYear}`)).body)).toEqual(['Kingdom B']);
    });

    it('reports a polity once even if it has several features at the point', async () => {
      expect(names((await get('/at?lat=45&lon=8&year=1100')).body)).toEqual(['Kingdom B']);
    });

    it('returns 200 with an empty list for a point with no data', async () => {
      const res = await get('/at?lat=0&lon=-30&year=1000');
      expect(res.statusCode).toBe(200);
      expect(res.json().polities).toEqual([]);
    });

    it.each([
      ['lat too big', '/at?lat=91&lon=0&year=1000'],
      ['lon too big', '/at?lat=0&lon=190&year=1000'],
      ['missing year', '/at?lat=0&lon=0'],
      ['non-numeric lat', '/at?lat=abc&lon=0&year=1000'],
      ['year before the first interval', '/at?lat=45&lon=2&year=999'],
      ['year after the current year', `/at?lat=45&lon=2&year=${thisYear + 1}`],
    ])('rejects %s with 400', async (_l, url) => {
      expect((await get(url)).statusCode).toBe(400);
    });
  });

  describe('GET /timeline', () => {
    it('builds the timeline of a point from HB intervals', async () => {
      expect((await get('/timeline?lat=45&lon=7')).json().periods).toEqual([
        { name: 'Kingdom A', color: expect.stringMatching(/^hsl/), from: 1000, to: 1100, source: 'hb' },
        { name: 'Kingdom B', color: expect.stringMatching(/^hsl/), from: 1000, to: null, source: 'hb' },
      ]);
    });

    it('includes unnamed territory as its own period', async () => {
      expect((await get('/timeline?lat=42&lon=22')).json().periods).toEqual([
        { name: 'Unnamed territory', color: 'hsl(0, 0%, 80%)', from: 1000, to: 1100, source: 'hb' },
      ]);
    });

    it('returns 200 with no periods for the sea and 400 for bad coordinates', async () => {
      expect((await get('/timeline?lat=0&lon=-30')).json().periods).toEqual([]);
      expect((await get('/timeline?lat=45&lon=181')).statusCode).toBe(400);
    });
  });

  describe('GET /history', () => {
    it('returns one contour per polity that ever held the point, with its span', async () => {
      const res = await get('/history?lat=45&lon=7');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.type).toBe('FeatureCollection');
      expect(body.features.map((f: { properties: unknown }) => f.properties)).toEqual([
        { name: 'Kingdom A', color: expect.stringMatching(/^hsl/), level: 2, source: 'hb', from: 1000, to: 1100, periods: [{ from: 1000, to: 1100 }] },
        { name: 'Kingdom B', color: expect.stringMatching(/^hsl/), level: 2, source: 'hb', from: 1000, to: null, periods: [{ from: 1000, to: null }] },
      ]);
      for (const f of body.features) expect(['Polygon', 'MultiPolygon']).toContain(f.geometry.type);
    });

    it("unions a polity's several features into a single contour", async () => {
      const res = await get('/history?lat=45&lon=8');
      const b = res.json().features.filter((f: { properties: { name: string } }) => f.properties.name === 'Kingdom B');
      expect(b).toHaveLength(1);
    });

    it('contour covers the whole polity, not just the clicked spot', async () => {
      const a = (await get('/history?lat=45&lon=2')).json().features[0];
      const lons = (JSON.stringify(a.geometry.coordinates).match(/-?\d+(\.\d+)?/g) ?? [])
        .filter((_: string, i: number) => i % 2 === 0).map(Number);
      expect(Math.min(...lons)).toBe(0);
      expect(Math.max(...lons)).toBe(10);
    });

    it.each([
      ['limit 0', 'limit=0'],
      ['limit above the maximum', 'limit=51'],
      ['negative offset', 'offset=-1'],
      ['non-numeric limit', 'limit=abc'],
    ])('rejects paging with %s', async (_label, query) => {
      expect((await get(`/history?lat=45&lon=7&${query}`)).statusCode).toBe(400);
    });

    it('an empty page for the sea has no total and no next page', async () => {
      expect((await get('/history?lat=0&lon=-30&limit=3')).json()).toEqual({
        type: 'FeatureCollection', features: [], total: 0, offset: 0, nextOffset: null,
      });
    });

    it('returns 200 with no features for the sea; rejects bad coordinates and bad levels', async () => {
      expect((await get('/history?lat=0&lon=-30')).json()).toEqual({ type: 'FeatureCollection', features: [] });
      expect((await get('/history?lat=45&lon=181')).statusCode).toBe(400);
      expect((await get('/history?lat=95&lon=0')).statusCode).toBe(400);
      expect((await get('/history?lat=45&lon=7&levels=5')).statusCode).toBe(400);
    });
  });

  it('empty database: /range is null, /at is 400', async () => {
    await clearAll(pool);
    expect((await get('/range')).json()).toEqual({ min: null, max: null });
    expect((await get('/at?lat=45&lon=2&year=1000')).statusCode).toBe(400);
    await seedFixture(pool);
  });
});

describe('point lookups use the light geometry', () => {
  beforeAll(async () => {
    await clearAll(pool);
    await pool.query("INSERT INTO polities (name, admin_level) VALUES ('Lookup Land', 2)");
    // geom is the small square 0..1; geom_lookup is deliberately larger (0..2) so the test can tell which one is used
    await pool.query(
      `INSERT INTO polity_geometries (polity_id, source, valid_from, geom, geom_lookup)
       SELECT 1, 'hb', 1000, ST_Multi(ST_GeomFromText('POLYGON((0 60,1 60,1 61,0 61,0 60))', 4326)),
                              ST_Multi(ST_GeomFromText('POLYGON((0 60,2 60,2 62,0 62,0 60))', 4326))`,
    );
  });
  afterAll(async () => {
    await clearAll(pool);
    await seedFixture(pool);
  });

  it('/at answers from geom_lookup', async () => {
    expect(names((await get('/at?lat=61.5&lon=1.5&year=1000')).body)).toEqual(['Lookup Land']);
  });

  it('/history rounds coordinates to 4 decimals (about 11 m) to keep the payload small', async () => {
    await pool.query("INSERT INTO polities (name, admin_level) VALUES ('Precise Land', 2)");
    await pool.query(
      `INSERT INTO polity_geometries (polity_id, source, valid_from, geom, geom_lookup)
       SELECT p.id, 'hb', 1000, g.geom, g.geom
       FROM polities p,
            LATERAL (SELECT ST_Multi(ST_GeomFromText('POLYGON((10.123456789 60.987654321,11.111111111 60.987654321,11.111111111 61.222222222,10.123456789 61.222222222,10.123456789 60.987654321))', 4326)) AS geom) g
       WHERE p.name = 'Precise Land'`,
    );
    const feature = (await get('/history?lat=61.1&lon=10.5')).json().features[0];
    const numbers: string[] = JSON.stringify(feature.geometry.coordinates).match(/-?\d+\.\d+/g) ?? [];
    expect(numbers.length).toBeGreaterThan(0);
    for (const n of numbers) expect(n.split('.')[1].length).toBeLessThanOrEqual(4);
  });

  it('/timeline and /history answer from geom_lookup too', async () => {
    expect((await get('/timeline?lat=61.5&lon=1.5')).json().periods.map((p: { name: string }) => p.name)).toEqual(['Lookup Land']);
    const features = (await get('/history?lat=61.5&lon=1.5')).json().features;
    expect(features.map((f: { properties: { name: string } }) => f.properties.name)).toEqual(['Lookup Land']);
  });
});

describe('HB + OHM data', () => {
  beforeAll(async () => {
    await clearAll(pool);
    await seedFixture(pool);
    await seedOhmFixture(pool);
  });
  afterAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS ohm_stage CASCADE');
    await clearAll(pool);
    await seedFixture(pool);
  });

  describe('GET /at', () => {
    it('OHM wins over HB and reports the regions of the state', async () => {
      const res = await get('/at?lat=44&lon=2&year=1060');
      expect(res.json().polities).toEqual([
        expect.objectContaining({ name: 'Realm X', adminLevel: 2, source: 'ohm' }),
      ]);
      expect(res.json().regions).toEqual([
        expect.objectContaining({ name: 'Region R', adminLevel: 4, source: 'ohm' }),
      ]);
    });

    it('HB fills the years before and after OHM coverage', async () => {
      expect((await get('/at?lat=44&lon=2&year=1000')).json().polities).toEqual([
        expect.objectContaining({ name: 'Kingdom A', source: 'hb' }),
      ]);
      expect((await get('/at?lat=44&lon=2&year=1090')).json().polities).toEqual([
        expect.objectContaining({ name: 'Kingdom A', source: 'hb' }),
      ]);
    });

    it('regions are only those that contain the point', async () => {
      const res = await get('/at?lat=44&lon=7&year=1060');
      expect(names(res.body)).toEqual(['Realm X']);
      expect(res.json().regions).toEqual([]);
    });

    it('OHM-only place', async () => {
      expect(names((await get('/at?lat=42&lon=32&year=1500')).body)).toEqual(['Licensed Land']);
    });
  });

  describe('GET /timeline', () => {
    it('OHM interval splits the HB interval it overrides', async () => {
      expect((await get('/timeline?lat=44&lon=2')).json().periods).toEqual([
        { name: 'Kingdom A', color: expect.stringMatching(/^hsl/), from: 1000, to: 1050, source: 'hb' },
        { name: 'Realm X', color: expect.stringMatching(/^hsl/), from: 1050, to: 1080, source: 'ohm' },
        { name: 'Kingdom A', color: expect.stringMatching(/^hsl/), from: 1081, to: 1100, source: 'hb' },
        { name: 'Kingdom B', color: expect.stringMatching(/^hsl/), from: 1100, to: null, source: 'hb' },
      ]);
    });

    it('OHM-only place has an open-ended OHM period', async () => {
      expect((await get('/timeline?lat=42&lon=32')).json().periods).toEqual([
        { name: 'Licensed Land', color: expect.stringMatching(/^hsl/), from: 1000, to: null, source: 'ohm' },
      ]);
    });
  });

  describe('GET /history paged (rewind): one feature per period, newest first, geometry only for the page', () => {
    const summary = (res: { json: () => { features: { properties: Record<string, unknown> }[] } }) =>
      res.json().features.map((f) => [f.properties.name, f.properties.from, f.properties.to, f.properties.source, f.properties.index]);

    it('first page', async () => {
      const res = await get('/history?lat=44&lon=2&limit=2');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(summary(res)).toEqual([
        ['Kingdom B', 1100, null, 'hb', 0],
        ['Kingdom A', 1081, 1100, 'hb', 1],
      ]);
      expect([body.total, body.offset, body.nextOffset]).toEqual([4, 0, 2]);
      expect(body.features.map((f: { properties: { mapYear: number } }) => f.properties.mapYear)).toEqual([1100, 1081]);
      for (const f of body.features) {
        expect(f.type).toBe('Feature');
        expect(['Polygon', 'MultiPolygon']).toContain(f.geometry.type);
        expect(f.properties).toMatchObject({ level: 2, color: expect.stringMatching(/^hsl/) });
      }
    });

    it('second page continues without overlap and ends with nextOffset null', async () => {
      const res = await get('/history?lat=44&lon=2&limit=2&offset=2');
      expect(summary(res)).toEqual([
        ['Realm X', 1050, 1080, 'ohm', 2],
        ['Kingdom A', 1000, 1050, 'hb', 3],
      ]);
      expect([res.json().total, res.json().offset, res.json().nextOffset]).toEqual([4, 2, null]);
    });

    it('a page that is not full still reports the end', async () => {
      const res = await get('/history?lat=44&lon=2&limit=3&offset=3');
      expect(summary(res)).toEqual([['Kingdom A', 1000, 1050, 'hb', 3]]);
      expect(res.json().nextOffset).toBeNull();
    });

    it('an offset beyond the end gives an empty page', async () => {
      const res = await get('/history?lat=44&lon=2&limit=2&offset=10');
      expect(res.json()).toMatchObject({ features: [], total: 4, offset: 10, nextOffset: null });
    });

    it('offset alone and limit alone both switch to paging (default limit 6 covers everything here)', async () => {
      expect(summary(await get('/history?lat=44&lon=2&offset=0')).length).toBe(4);
      expect(summary(await get('/history?lat=44&lon=2&limit=50')).length).toBe(4);
    });

    it('levels=2,3,4 puts the regions among the periods', async () => {
      const res = await get('/history?lat=44&lon=2&levels=2,3,4&limit=10');
      expect(summary(res).map((r) => r[0])).toEqual(['Kingdom B', 'Kingdom A', 'Region R', 'Realm X', 'Kingdom A']);
      expect(res.json().total).toBe(5);
      expect(res.json().features[2].properties).toMatchObject({ level: 4, from: 1060, to: 1070 });
    });

    it('the unpaged call keeps returning one contour per polity', async () => {
      const features = (await get('/history?lat=44&lon=2')).json().features;
      expect(features.map((f: { properties: { name: string } }) => f.properties.name)).toEqual(['Kingdom A', 'Realm X', 'Kingdom B']);
    });
  });

  describe('GET /history', () => {
    it('defaults to level 2 and resolves HB against OHM', async () => {
      const features = (await get('/history?lat=44&lon=2')).json().features;
      expect(features.map((f: { properties: { name: string } }) => f.properties.name)).toEqual([
        'Kingdom A', 'Realm X', 'Kingdom B',
      ]);
      expect(features[0].properties).toMatchObject({
        source: 'hb', from: 1000, to: 1100, periods: [{ from: 1000, to: 1050 }, { from: 1081, to: 1100 }],
      });
      expect(features[1].properties).toMatchObject({ source: 'ohm', level: 2, from: 1050, to: 1080 });
    });

    it('levels=2,3,4 adds the regions', async () => {
      const features = (await get('/history?lat=44&lon=2&levels=2,3,4')).json().features;
      expect(features.map((f: { properties: { name: string } }) => f.properties.name)).toEqual([
        'Kingdom A', 'Realm X', 'Region R', 'Kingdom B',
      ]);
      expect(features[2].properties).toMatchObject({ level: 4, source: 'ohm', from: 1060, to: 1070 });
    });
  });
});
