import { t } from './strings';

export const UNNAMED = 'Unnamed territory';

export function formatYear(year: number): string {
  return year < 0 ? `${-year} ${t.bc}` : String(year);
}

export function polityLabel(name: string): string {
  return name === UNNAMED ? t.lackOfData : name;
}

export function tileUrl(base: string, year: number): string {
  return `${base}/polities_tile/{z}/{x}/{y}?year=${year}`;
}

export function clampYear(raw: string, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(raw));
  if (raw.trim() === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
