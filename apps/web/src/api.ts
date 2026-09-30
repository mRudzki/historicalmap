export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
export const TILES_URL: string = import.meta.env.VITE_TILES_URL ?? 'http://localhost:3100';

export interface PolityAt {
  id: number; name: string; adminLevel: number; source: 'ohm' | 'hb';
  borderPrecision: number | null; color: string;
}
export interface AtResponse { year: number; polities: PolityAt[]; regions: PolityAt[] }
export interface Period { name: string; color: string; from: number; to: number | null; source: 'ohm' | 'hb' }

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return (await res.json()) as T;
}

export const fetchRange = () => getJson<{ min: number | null; max: number | null }>('/range');
export const fetchAt = (lat: number, lon: number, year: number) =>
  getJson<AtResponse>(`/at?lat=${lat}&lon=${lon}&year=${year}`);
export const fetchTimeline = (lat: number, lon: number) =>
  getJson<{ periods: Period[] }>(`/timeline?lat=${lat}&lon=${lon}`).then((r) => r.periods);

export interface HistoryProperties {
  name: string;
  color: string;
  level: number;
  source: 'ohm' | 'hb';
  from: number;
  to: number | null;
  periods: { from: number; to: number | null }[];
}
export interface HistoryFeature {
  type: 'Feature';
  properties: HistoryProperties;
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };
}
export interface HistoryCollection { type: 'FeatureCollection'; features: HistoryFeature[] }

export const fetchHistory = (lat: number, lon: number, withRegions: boolean) =>
  getJson<HistoryCollection>(`/history?lat=${lat}&lon=${lon}${withRegions ? '&levels=2,3,4' : ''}`);
