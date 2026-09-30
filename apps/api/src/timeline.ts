export interface TimelineRow { name: string; color: string; year: number }
export interface Period { name: string; color: string; from: number; to: number | null }

export function buildTimeline(rows: TimelineRow[], allYears: number[]): Period[] {
  const sorted = [...allYears].sort((a, b) => a - b);
  const indexOf = new Map(sorted.map((y, i) => [y, i]));

  const byName = new Map<string, { color: string; idx: Set<number> }>();
  for (const r of rows) {
    const i = indexOf.get(r.year);
    if (i === undefined) continue;
    const entry = byName.get(r.name) ?? { color: r.color, idx: new Set<number>() };
    entry.idx.add(i);
    byName.set(r.name, entry);
  }

  const periods: Period[] = [];
  for (const [name, { color, idx }] of byName) {
    const list = [...idx].sort((a, b) => a - b);
    let start = list[0];
    let prev = list[0];
    const flush = () =>
      periods.push({ name, color, from: sorted[start], to: sorted[prev + 1] ?? null });
    for (const i of list.slice(1)) {
      if (i === prev + 1) { prev = i; continue; }
      flush();
      start = i;
      prev = i;
    }
    flush();
  }
  return periods.sort((a, b) => a.from - b.from || a.name.localeCompare(b.name));
}
