import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { TILES_URL, fetchAt, fetchHistory, fetchSnapshots, fetchTimeline } from './api';
import { formatYear, tileUrl } from './format';
import { PinLayer, HISTORY_SOURCE, emptyHistory, historyLayers } from './pin-mode';
import { renderHistoryPanel, renderPanel } from './panel';

// Production: the worker is emitted by the maplibreWorker plugin in vite.config.ts (dev needs nothing).
if (import.meta.env.PROD) {
  maplibregl.setWorkerUrl(new URL('maplibre/maplibre-gl-worker.mjs', document.baseURI).href);
}

const params = new URLSearchParams(location.search);
const center: [number, number] = [Number(params.get('lng') ?? 12), Number(params.get('lat') ?? 50)];
const zoom = Number(params.get('zoom') ?? 3);

const mapEl = document.getElementById('map') as HTMLElement;
const panel = document.getElementById('panel') as HTMLElement;
const slider = document.getElementById('slider') as HTMLInputElement;
const yearLabel = document.getElementById('year-label') as HTMLElement;
const controls = document.getElementById('controls') as HTMLElement;
const modeYear = document.getElementById('mode-year') as HTMLButtonElement;
const modePin = document.getElementById('mode-pin') as HTMLButtonElement;

let years: number[];
try {
  years = await fetchSnapshots();
} catch {
  yearLabel.textContent = 'Nie udało się połączyć z serwerem. Odśwież stronę za chwilę.';
  throw new Error('API unavailable');
}
if (years.length === 0) {
  yearLabel.textContent = 'brak danych — uruchom import';
  throw new Error('No snapshots in the database');
}

slider.max = String(years.length - 1);
slider.value = String(years.length - 1);
const currentYear = () => years[Number(slider.value)];
const showYear = () => (yearLabel.textContent = formatYear(currentYear()));
showYear();

const source = 'polities';
const attribution =
  'Granice: <a href="https://github.com/aourednik/historical-basemaps">Historical Basemaps</a> (GPL-3.0)';

const map = new maplibregl.Map({
  container: mapEl,
  center,
  zoom,
  style: {
    version: 8,
    projection: { type: 'globe' },
    sources: {
      [source]: { type: 'vector', tiles: [tileUrl(TILES_URL, currentYear())], minzoom: 0, maxzoom: 8, attribution },
      [HISTORY_SOURCE]: { type: 'geojson', data: emptyHistory as never },
    },
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': '#bcd7e6' } },
      {
        id: 'polity-fill', type: 'fill', source, 'source-layer': 'polities',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.85 },
      },
      {
        id: 'polity-line-precise', type: 'line', source, 'source-layer': 'polities',
        filter: ['!=', ['get', 'border_precision'], 1],
        paint: { 'line-color': '#444', 'line-width': 0.8 },
      },
      {
        id: 'polity-line-approx', type: 'line', source, 'source-layer': 'polities',
        filter: ['==', ['get', 'border_precision'], 1],
        paint: { 'line-color': '#444', 'line-width': 0.8, 'line-dasharray': [3, 2] },
      },
      ...historyLayers,
    ],
  },
});

// Test hook: lets the e2e test check that tiles are actually rendered.
(window as unknown as { __map: maplibregl.Map }).__map = map;

const setTiles = (year: number) =>
  (map.getSource(source) as maplibregl.VectorTileSource).setTiles([tileUrl(TILES_URL, year)]);

const pin = new PinLayer(map);
type Mode = 'year' | 'pin';
let mode: Mode = 'year';
let latestClick = 0; // ignore responses of clicks that were superseded

function setMode(next: Mode): void {
  mode = next;
  latestClick++;
  panel.hidden = true;
  modeYear.setAttribute('aria-pressed', String(next === 'year'));
  modePin.setAttribute('aria-pressed', String(next === 'pin'));
  controls.hidden = next === 'pin';
  pin.setVisible(next === 'pin');
  if (next === 'pin') {
    // Neutral, modern-day land as context so the coloured contours stay readable.
    setTiles(years[years.length - 1]);
    map.setPaintProperty('polity-fill', 'fill-color', '#e2e2e2');
  } else {
    pin.clear();
    setTiles(currentYear());
    map.setPaintProperty('polity-fill', 'fill-color', ['get', 'color']);
  }
}
modeYear.addEventListener('click', () => setMode('year'));
modePin.addEventListener('click', () => setMode('pin'));

slider.addEventListener('input', () => {
  showYear();
  setTiles(currentYear());
});

map.on('click', async (e) => {
  const { lat, lng } = e.lngLat.wrap();
  const id = ++latestClick;
  try {
    if (mode === 'pin') {
      const history = await fetchHistory(lat, lng);
      if (id !== latestClick) return;
      pin.show([lng, lat], history);
      renderHistoryPanel(panel, history.features, (name) => pin.highlight(name));
    } else {
      const [at, periods] = await Promise.all([fetchAt(lat, lng, currentYear()), fetchTimeline(lat, lng)]);
      if (id !== latestClick) return;
      renderPanel(panel, at, periods);
    }
  } catch {
    if (id !== latestClick) return;
    panel.hidden = false;
    panel.textContent = 'Nie udało się pobrać danych. Spróbuj kliknąć ponownie.';
  }
});
