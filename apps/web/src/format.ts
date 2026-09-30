export const UNNAMED = 'Unnamed territory';

export function formatYear(year: number): string {
  return year < 0 ? `${-year} p.n.e.` : String(year);
}

export function polityLabel(name: string): string {
  return name === UNNAMED ? 'Terytorium bez nazwy' : name;
}

export function tileUrl(base: string, year: number): string {
  return `${base}/polities_tile/{z}/{x}/{y}?year=${year}`;
}
