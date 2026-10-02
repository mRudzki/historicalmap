import { describe, expect, it } from 'vitest';
import { displayPeriod, mapYearFor, resolveTimeline, type Interval } from '../src/resolve-timeline';

const iv = (name: string, from: number, to: number | null): Interval => ({ name, color: `c-${name}`, from, to });
const simple = (ps: ReturnType<typeof resolveTimeline>) => ps.map((p) => [p.name, p.from, p.to, p.source]);

describe('resolveTimeline', () => {
  it('OHM beats HB and HB keeps only the parts OHM does not cover (Alsace)', () => {
    const ohm = [iv('German Reich', 1871.34, 1878.53), iv('German Reich', 1878.53, 1890.5), iv('German Reich', 1890.5, 1918.86)];
    const hb = [iv('France', 1815, 1914), iv('German Empire', 1914, 1920), iv('France', 1920, null)];
    expect(simple(resolveTimeline(ohm, hb))).toEqual([
      ['France', 1815, 1871.34, 'hb'],
      ['German Reich', 1871.34, 1918.86, 'ohm'], // three OHM versions merged
      ['German Empire', 1918.86, 1920, 'hb'],
      ['France', 1920, null, 'hb'],
    ]);
  });

  it('drops HB slivers shorter than a year left between OHM intervals (real data, 1918)', () => {
    const ohm = [iv('German Reich', 1890.5, 1918.86), iv('French Republic', 1918.89, 1940.48)];
    const hb = [iv('German Empire', 1914, 1920)];
    expect(simple(resolveTimeline(ohm, hb))).toEqual([
      ['German Reich', 1890.5, 1918.86, 'ohm'],
      ['French Republic', 1918.89, 1940.48, 'ohm'],
    ]);
  });

  it('keeps HB whole where OHM has no coverage', () => {
    expect(simple(resolveTimeline([], [iv('A', 1000, 1100)]))).toEqual([['A', 1000, 1100, 'hb']]);
  });

  it('drops an HB interval completely covered by OHM', () => {
    expect(simple(resolveTimeline([iv('X', 900, 1200)], [iv('A', 1000, 1100)]))).toEqual([['X', 900, 1200, 'ohm']]);
  });

  it('an open-ended OHM interval hides all later HB', () => {
    expect(simple(resolveTimeline([iv('X', 1500, null)], [iv('A', 1000, null)]))).toEqual([
      ['A', 1000, 1500, 'hb'],
      ['X', 1500, null, 'ohm'],
    ]);
  });

  it('merges same-name intervals separated by less than one year, not by more', () => {
    expect(simple(resolveTimeline([iv('X', 1000, 1010), iv('X', 1010.5, 1020)], []))).toEqual([['X', 1000, 1020, 'ohm']]);
    expect(simple(resolveTimeline([iv('X', 1000, 1010), iv('X', 1012, 1020)], []))).toEqual([
      ['X', 1000, 1010, 'ohm'],
      ['X', 1012, 1020, 'ohm'],
    ]);
  });

  it('merges same-name pieces across sources and marks the merged one as ohm', () => {
    const res = resolveTimeline([iv('France', 1500, 1600)], [iv('France', 1400, 1500)]);
    expect(simple(res)).toEqual([['France', 1400, 1600, 'ohm']]);
  });

  it('sorts by start then name and returns [] for no input', () => {
    expect(resolveTimeline([], [])).toEqual([]);
    expect(resolveTimeline([iv('B', 1000, 1010), iv('A', 1000, 1010)], []).map((p) => p.name)).toEqual(['A', 'B']);
  });
});

describe('displayPeriod', () => {
  it('rounds down; OHM ends inclusively, HB ends at the next snapshot year', () => {
    expect(displayPeriod({ name: 'X', color: 'c', from: 1871.34, to: 1918.86, source: 'ohm' })).toMatchObject({ from: 1871, to: 1918 });
    expect(displayPeriod({ name: 'X', color: 'c', from: 1000, to: 1872, source: 'ohm' })).toMatchObject({ from: 1000, to: 1871 });
    expect(displayPeriod({ name: 'A', color: 'c', from: 1715, to: 1783, source: 'hb' })).toMatchObject({ from: 1715, to: 1783 });
    expect(displayPeriod({ name: 'A', color: 'c', from: 1783, to: null, source: 'hb' })).toMatchObject({ to: null });
  });
});

describe('mapYearFor', () => {
  // the map shows the state of a year at year + 0.5, so the year must put that moment inside the period
  it.each([
    ['starts mid-year: the first year whose middle is inside', 1918.89, 1940.48, 1919],
    ['starts early in the year', 1871.34, 1878.53, 1871],
    ['starts exactly on a year boundary', 1000, 1050, 1000],
    ['open-ended', 1945.3, null, 1945],
    ['BC years', -27.2, -18, -27],
  ])('%s', (_label, from, to, expected) => {
    expect(mapYearFor(from, to)).toBe(expected);
  });

  it('falls back to the start year for a period shorter than that', () => {
    expect(mapYearFor(1000.6, 1000.9)).toBe(1000);
  });
});
