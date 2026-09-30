export interface Interval { name: string; color: string; from: number; to: number | null }
export interface Period extends Interval { source: 'ohm' | 'hb' }

const MERGE_GAP = 1; // years: same-name intervals closer than this are one period
const endOf = (to: number | null) => to ?? Infinity;

function union(intervals: Interval[]): [number, number][] {
  const sorted = intervals.map((i) => [i.from, endOf(i.to)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = out[out.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

function subtract(i: Interval, holes: [number, number][]): Interval[] {
  const pieces: Interval[] = [];
  const limit = endOf(i.to);
  let cursor = i.from;
  for (const [hFrom, hTo] of holes) {
    if (hTo <= cursor) continue;
    if (hFrom >= limit) break;
    if (hFrom > cursor) pieces.push({ ...i, from: cursor, to: hFrom });
    cursor = Math.max(cursor, hTo);
  }
  if (cursor < limit) pieces.push({ ...i, from: cursor, to: i.to });
  return pieces;
}

export function resolveTimeline(ohm: Interval[], hb: Interval[]): Period[] {
  const holes = union(ohm);
  const all: Period[] = [
    ...ohm.map((i) => ({ ...i, source: 'ohm' as const })),
    // pieces shorter than the merge gap are artefacts of gaps in the OHM data, not real periods
    ...hb.flatMap((i) => subtract(i, holes))
      .filter((i) => endOf(i.to) - i.from >= MERGE_GAP)
      .map((i) => ({ ...i, source: 'hb' as const })),
  ];

  const byName = new Map<string, Period[]>();
  for (const p of all) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);

  const merged: Period[] = [];
  for (const list of byName.values()) {
    list.sort((a, b) => a.from - b.from);
    let cur = { ...list[0] };
    for (const p of list.slice(1)) {
      if (p.from <= endOf(cur.to) + MERGE_GAP) {
        const to = Math.max(endOf(cur.to), endOf(p.to));
        cur = { ...cur, to: to === Infinity ? null : to, source: cur.source === 'ohm' || p.source === 'ohm' ? 'ohm' : 'hb' };
      } else {
        merged.push(cur);
        cur = { ...p };
      }
    }
    merged.push(cur);
  }
  return merged.sort((a, b) => a.from - b.from || a.name.localeCompare(b.name));
}

export function displayPeriod(p: Period) {
  const to = p.to === null ? null : p.source === 'ohm' ? Math.floor(p.to - 1e-6) : Math.floor(p.to);
  return { name: p.name, color: p.color, from: Math.floor(p.from), to, source: p.source };
}
