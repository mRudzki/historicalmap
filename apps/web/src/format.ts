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

// "54.35, 18.65", "54.35 18.65", "54.35;18.65", "54.35° N, 18.65° E", "54.35 S, 18.65 W".
// Dot decimals only: "54,35" would be ambiguous with the separator.
const COORDINATES = /^(-?\d+(?:\.\d+)?)\s*([NS])?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*([EW])?$/i;

export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  const m = COORDINATES.exec(text.replace(/°/g, '').trim());
  if (!m) return null;
  let lat = Number(m[1]);
  let lng = Number(m[3]);
  const ns = m[2]?.toUpperCase();
  const ew = m[4]?.toUpperCase();
  if ((ns === 'S' && m[1].startsWith('-')) || (ew === 'W' && m[3].startsWith('-'))) return null;
  if (ns === 'S') lat = -lat;
  if (ew === 'W') lng = -lng;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

// In production the app is served from one origin (/api, /tiles); MapLibre needs absolute tile URLs.
export function absoluteUrl(url: string, origin: string): string {
  return url.startsWith('/') ? origin + url : url;
}
