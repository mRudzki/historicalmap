import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearAll, seedFixture, testPool } from '../../../db/test-support';
import { createApp } from '../src/app';

const pool = testPool();
const app = createApp(pool);

beforeAll(async () => {
  await clearAll(pool);
  await seedFixture(pool);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const get = (url: string) => app.inject({ method: 'GET', url });
const names = (body: string) => JSON.parse(body).polities.map((p: { name: string }) => p.name).sort();

describe('GET /snapshots', () => {
  it('lists snapshot years ascending', async () => {
    const res = await get('/snapshots');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ years: [1000, 1100] });
  });
});

describe('GET /at', () => {
  it('returns the polity at a point', async () => {
    const res = await get('/at?lat=45&lon=2&year=1000');
    expect(res.statusCode).toBe(200);
    expect(res.json().snapshotYear).toBe(1000);
    expect(names(res.body)).toEqual(['Kingdom A']);
  });

  it('returns every overlapping polity', async () => {
    expect(names((await get('/at?lat=45&lon=7&year=1000')).body)).toEqual(['Kingdom A', 'Kingdom B']);
  });

  it('floors a year between snapshots to the earlier snapshot', async () => {
    const res = await get('/at?lat=45&lon=7&year=1050');
    expect(res.json().snapshotYear).toBe(1000);
  });

  it('reports a polity once even if it has several features at the point', async () => {
    const res = await get('/at?lat=45&lon=8&year=1100');
    expect(names(res.body)).toEqual(['Kingdom B']);
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
    ['year before first snapshot', '/at?lat=45&lon=2&year=999'],
    ['year after last snapshot', '/at?lat=45&lon=2&year=1101'],
  ])('rejects %s with 400', async (_l, url) => {
    expect((await get(url)).statusCode).toBe(400);
  });
});

describe('GET /timeline', () => {
  it('builds the timeline of a point', async () => {
    const res = await get('/timeline?lat=45&lon=7');
    expect(res.json().periods).toEqual([
      { name: 'Kingdom A', color: expect.stringMatching(/^hsl/), from: 1000, to: 1100 },
      { name: 'Kingdom B', color: expect.stringMatching(/^hsl/), from: 1000, to: null },
    ]);
  });

  it('includes unnamed territory as its own period', async () => {
    const res = await get('/timeline?lat=42&lon=22');
    expect(res.json().periods).toEqual([
      { name: 'Unnamed territory', color: 'hsl(0, 0%, 80%)', from: 1000, to: 1100 },
    ]);
  });

  it('returns 200 with no periods for the sea', async () => {
    const res = await get('/timeline?lat=0&lon=-30');
    expect(res.statusCode).toBe(200);
    expect(res.json().periods).toEqual([]);
  });

  it('rejects out-of-range coordinates', async () => {
    expect((await get('/timeline?lat=45&lon=181')).statusCode).toBe(400);
  });
});

describe('empty database', () => {
  it('returns no snapshots and 400 on /at', async () => {
    await clearAll(pool);
    expect((await get('/snapshots')).json()).toEqual({ years: [] });
    expect((await get('/at?lat=45&lon=2&year=1000')).statusCode).toBe(400);
    await seedFixture(pool);
  });
});
