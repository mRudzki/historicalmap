import { describe, expect, it } from 'vitest';
import type { HistoryFeature } from './api';
import { Rewind, type RewindPage } from './rewind';

const feature = (i: number): HistoryFeature => ({
  type: 'Feature',
  properties: { name: `P${i}`, color: 'c', level: 2, source: 'ohm', from: 1000 - i, to: null, periods: [] },
  geometry: { type: 'Polygon', coordinates: [] },
});

// A fake backend with `total` periods, newest first; records every request.
function backend(total: number) {
  const all = Array.from({ length: total }, (_, i) => feature(i));
  const calls: [number, number][] = [];
  const fetchPage = async (offset: number, limit: number): Promise<RewindPage> => {
    calls.push([offset, limit]);
    const features = all.slice(offset, offset + limit);
    const end = offset + features.length;
    return { features, total, offset, nextOffset: end < total ? end : null };
  };
  return { fetchPage, calls };
}

const make = (total: number, over: Partial<ConstructorParameters<typeof Rewind>[0]> = {}) => {
  const b = backend(total);
  const changes: number[] = [];
  const rewind = new Rewind({ fetchPage: b.fetchPage, firstPage: 3, pageSize: 4, prefetchAhead: 2, onChange: () => changes.push(1), ...over });
  return { rewind, ...b, changes };
};

describe('Rewind', () => {
  it('loads a small first page, starts at the newest period and prefetches the next page in the background', async () => {
    const { rewind, calls } = make(10);
    await rewind.start();
    expect(calls[0]).toEqual([0, 3]);
    expect(rewind.index).toBe(0);
    expect(rewind.current?.properties.name).toBe('P0');
    await rewind.whenIdle();
    expect(calls[1]).toEqual([3, 4]); // 3 loaded, only 2 ahead of the index: prefetch
    expect(rewind.items).toHaveLength(7);
    expect(rewind.total).toBe(10);
  });

  it('steps back through the periods and keeps prefetching ahead of the user', async () => {
    const { rewind } = make(10);
    await rewind.start();
    await rewind.whenIdle();
    for (let i = 0; i < 4; i++) await rewind.older();
    await rewind.whenIdle();
    expect(rewind.index).toBe(4);
    expect(rewind.items).toHaveLength(10); // 7 - 1 - 4 = 2 ahead -> the last page was fetched
    expect(rewind.current?.properties.name).toBe('P4');
  });

  it('stops at both ends', async () => {
    const { rewind } = make(5);
    await rewind.start();
    await rewind.whenIdle();
    rewind.newer();
    expect(rewind.index).toBe(0);
    expect(rewind.canNewer).toBe(false);
    for (let i = 0; i < 10; i++) await rewind.older();
    expect(rewind.index).toBe(4);
    expect(rewind.canOlder).toBe(false);
    expect(rewind.current?.properties.name).toBe('P4');
  });

  it('waits for the page when the user outruns the prefetch', async () => {
    const { rewind } = make(10, { prefetchAhead: 0 });
    await rewind.start(); // 3 items loaded, no prefetch while ahead > 0
    await rewind.whenIdle();
    await rewind.older();
    await rewind.older();
    expect(rewind.index).toBe(2);
    await rewind.older(); // needs item 3: fetches the next page first
    expect(rewind.index).toBe(3);
    expect(rewind.items.length).toBeGreaterThanOrEqual(4);
  });

  it('goTo clamps to the loaded periods', async () => {
    const { rewind } = make(10);
    await rewind.start();
    await rewind.whenIdle();
    rewind.goTo(99);
    expect(rewind.index).toBe(rewind.items.length - 1);
    rewind.goTo(-5);
    expect(rewind.index).toBe(0);
  });

  it('ignores the answer of a superseded start (user placed another pin)', async () => {
    const slow = backend(5);
    let release: (() => void) | undefined;
    let first = true;
    const rewind = new Rewind({
      firstPage: 3, pageSize: 4, prefetchAhead: 2, onChange: () => {},
      fetchPage: async (offset, limit) => {
        if (first) { first = false; await new Promise<void>((r) => (release = r)); } // the first request hangs
        return slow.fetchPage(offset, limit);
      },
    });
    const stale = rewind.start();
    const fresh = rewind.start();
    await fresh;
    release?.();
    await stale;
    await rewind.whenIdle();
    expect(rewind.items.map((f) => f.properties.name)).toEqual(['P0', 'P1', 'P2', 'P3', 'P4']); // no duplicates from the stale call
  });

  it('keeps what it has and offers a retry when a page fails', async () => {
    let fail = false;
    const b = backend(10);
    const rewind = new Rewind({
      firstPage: 3, pageSize: 4, prefetchAhead: 0, onChange: () => {},
      fetchPage: async (o, l) => { if (fail) throw new Error('boom'); return b.fetchPage(o, l); },
    });
    await rewind.start();
    await rewind.older(); // index 1
    fail = true;
    await rewind.older(); // index 2: the prefetch at the end of the loaded pages fails in the background
    await rewind.whenIdle();
    await rewind.older(); // needs the next page, which fails again
    expect(rewind.error).toBe(true);
    expect(rewind.index).toBe(2); // did not move, nothing lost
    expect(rewind.items).toHaveLength(3);
    fail = false;
    await rewind.retry();
    expect(rewind.error).toBe(false);
    await rewind.older();
    expect(rewind.index).toBe(3);
  });

  it('notifies on every visible change', async () => {
    const { rewind, changes } = make(5);
    await rewind.start();
    const before = changes.length;
    await rewind.older();
    expect(changes.length).toBeGreaterThan(before);
  });
});
