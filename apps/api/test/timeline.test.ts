import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../src/timeline';

const years = [1000, 1100, 1200, 1300];

describe('buildTimeline', () => {
  it('merges consecutive snapshots and ends at the next snapshot year', () => {
    const rows = [
      { name: 'A', color: 'c1', year: 1000 },
      { name: 'A', color: 'c1', year: 1100 },
    ];
    expect(buildTimeline(rows, years)).toEqual([{ name: 'A', color: 'c1', from: 1000, to: 1200 }]);
  });

  it('leaves `to` null when the run reaches the last snapshot', () => {
    const rows = [{ name: 'A', color: 'c1', year: 1300 }];
    expect(buildTimeline(rows, years)).toEqual([{ name: 'A', color: 'c1', from: 1300, to: null }]);
  });

  it('splits a polity that disappears and comes back', () => {
    const rows = [
      { name: 'A', color: 'c1', year: 1000 },
      { name: 'A', color: 'c1', year: 1200 },
    ];
    expect(buildTimeline(rows, years)).toEqual([
      { name: 'A', color: 'c1', from: 1000, to: 1100 },
      { name: 'A', color: 'c1', from: 1200, to: 1300 },
    ]);
  });

  it('ignores duplicate rows and sorts by start then name', () => {
    const rows = [
      { name: 'B', color: 'c2', year: 1000 },
      { name: 'B', color: 'c2', year: 1000 },
      { name: 'A', color: 'c1', year: 1000 },
    ];
    expect(buildTimeline(rows, years).map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('returns [] for no rows', () => {
    expect(buildTimeline([], years)).toEqual([]);
  });
});
