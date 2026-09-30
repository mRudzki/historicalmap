export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
export const TILES_URL: string = import.meta.env.VITE_TILES_URL ?? 'http://localhost:3100';

export interface PolityAt { id: number; name: string; subjecto: string | null; borderPrecision: number | null; color: string }
export interface AtResponse { year: number; snapshotYear: number | null; polities: PolityAt[] }
export interface Period { name: string; color: string; from: number; to: number | null }

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return (await res.json()) as T;
}

export const fetchSnapshots = () => getJson<{ years: number[] }>('/snapshots').then((r) => r.years);
export const fetchAt = (lat: number, lon: number, year: number) =>
  getJson<AtResponse>(`/at?lat=${lat}&lon=${lon}&year=${year}`);
export const fetchTimeline = (lat: number, lon: number) =>
  getJson<{ periods: Period[] }>(`/timeline?lat=${lat}&lon=${lon}`).then((r) => r.periods);
