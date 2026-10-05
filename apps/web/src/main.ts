import * as maplibregl from 'maplibre-gl';
import type { LayerSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { TILES_URL, fetchAt, fetchHistory, fetchHistoryPage, fetchRange, fetchTimeline } from './api';
import { clampYear, formatYear, parseCoordinates, tileUrl } from './format';
import { PinLayer, HISTORY_SOURCE, emptyHistory, historyLayers } from './pin-mode';
import { renderHistoryPanel, renderPanel, renderRewindPanel, type PinView } from './panel';
import { Rewind } from './rewind';
import { t } from './strings';

// Production: the worker is emitted by the maplibreWorker plugin in vite.config.ts (dev needs nothing).
if (import.meta.env.PROD) {
  maplibregl.setWorkerUrl(new URL('maplibre/maplibre-gl-worker.mjs', document.baseURI).href);
}

const params = new URLSearchParams(location.search);
const center: [number, number] = [Number(params.get('lng') ?? 12), Number(params.get('lat') ?? 45)];
const zoom = Number(params.get('zoom') ?? 2);

const mapEl = document.getElementById('map') as HTMLElement;
const panel = document.getElementById('panel') as HTMLElement;
const slider = document.getElementById('slider') as HTMLInputElement;
const yearLabel = document.getElementById('year-label') as HTMLElement;
const controls = document.getElementById('controls') as HTMLElement;
const modeYear = document.getElementById('mode-year') as HTMLButtonElement;
const modePin = document.getElementById('mode-pin') as HTMLButtonElement;
const yearInput = document.getElementById('year-input') as HTMLInputElement;
const regionsBox = document.getElementById('regions') as HTMLInputElement;
const coordsForm = document.getElementById('coords') as HTMLFormElement;
const coordsInput = document.getElementById('coords-input') as HTMLInputElement;
const coordsError = document.getElementById('coords-error') as HTMLElement;

// The API may be briefly down (restart, deploy): keep retrying instead of leaving a dead page.
async function loadRange(): Promise<{ min: number | null; max: number | null }> {
  for (;;) {
    try {
      return await fetchRange();
    } catch {
      yearLabel.textContent = t.serverUnreachable;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
const range = await loadRange();
if (range.min === null || range.max === null) {
  yearLabel.textContent = t.noImportedData;
  throw new Error('No data in the database');
}
const { min, max } = { min: range.min, max: range.max };

let year = max;
slider.min = yearInput.min = String(min);
slider.max = yearInput.max = String(max);
const showYear = () => {
  slider.value = yearInput.value = String(year);
  yearLabel.textContent = formatYear(year);
};
showYear();

const source = 'polities';
// HB fallback is drawn paler (approximate) under the opaque OHM fill.
const FILL_LAYERS = [
  { id: 'fallback-fill', layer: 'fallback', opacity: 0.55 },
  { id: 'polity-fill', layer: 'polities', opacity: 1 },
] as const;
const attribution =
  'Borders: <a href="https://www.openhistoricalmap.org/">OpenHistoricalMap</a> (CC0), <a href="https://github.com/aourednik/historical-basemaps">Historical Basemaps</a> (GPL-3.0), coastlines: <a href="https://www.naturalearthdata.com/">Natural Earth</a>';

const fillLayer = (id: string, layer: string, opacity: number): LayerSpecification => ({
  id, type: 'fill', source, 'source-layer': layer,
  paint: { 'fill-color': ['get', 'color'], 'fill-opacity': opacity },
});
const lineLayers = (layer: string): LayerSpecification[] => [
  {
    id: `${layer}-line-precise`, type: 'line', source, 'source-layer': layer,
    filter: ['!=', ['get', 'border_precision'], 1],
    paint: { 'line-color': '#444', 'line-width': 0.8 },
  },
  {
    id: `${layer}-line-approx`, type: 'line', source, 'source-layer': layer,
    filter: ['==', ['get', 'border_precision'], 1],
    paint: { 'line-color': '#444', 'line-width': 0.8, 'line-dasharray': [3, 2] },
  },
];

const map = new maplibregl.Map({
  container: mapEl,
  center,
  zoom,
  style: {
    version: 8,
    projection: { type: 'globe' },
    sources: {
      [source]: { type: 'vector', tiles: [tileUrl(TILES_URL, year)], minzoom: 0, maxzoom: 8, attribution },
      [HISTORY_SOURCE]: { type: 'geojson', data: emptyHistory as never },
    },
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': '#bcd7e6' } },
      // HB (approximate) sits below OHM: its borders must not be drawn over the opaque OHM fill
      fillLayer('fallback-fill', 'fallback', 0.55),
      ...lineLayers('fallback'),
      fillLayer('polity-fill', 'polities', 1),
      ...lineLayers('polities'),
      {
        id: 'regions-line', type: 'line', source, 'source-layer': 'regions', layout: { visibility: 'none' },
        paint: { 'line-color': '#666', 'line-width': 0.7, 'line-dasharray': [1, 2] },
      },
      ...historyLayers,
    ],
  },
});

// Test hook: lets the e2e test check that tiles are actually rendered.
(window as unknown as { __map: maplibregl.Map }).__map = map;

let tilesTimer: ReturnType<typeof setTimeout> | undefined;
const setTiles = (y: number) =>
  (map.getSource(source) as maplibregl.VectorTileSource).setTiles([tileUrl(TILES_URL, y)]);
const setTilesSoon = (y: number) => {
  clearTimeout(tilesTimer);
  tilesTimer = setTimeout(() => setTiles(y), 150);
};

const pin = new PinLayer(map);
type Mode = 'year' | 'pin';
let mode: Mode = 'year';
let latestClick = 0; // ignore responses of clicks that were superseded

// Pin mode has two views: "rewind" (default: step back through the periods, loaded page by page) and "all".
let pinView: PinView = 'rewind';
let syncMap = true; // show the map of the period's year in the background
let rewind: Rewind | null = null;
let playTimer: ReturnType<typeof setTimeout> | undefined;
let backgroundYear: number | null = null;
// A shown period needs its contour rendered and, in sync mode, a whole year of tiles fetched:
// slow enough for the backend to keep up (the world data set is heavy).
const PLAY_MS = 3000;

const playing = () => playTimer !== undefined;
function stopPlay(): void {
  clearTimeout(playTimer);
  playTimer = undefined;
}

// Play: the pause restarts after each finished step (which may first wait for the next page to
// load), so a slow backend delays the next period instead of skipping it on a fixed tick grid.
function schedulePlay(): void {
  playTimer = setTimeout(() => void stepPlay(), PLAY_MS);
}
async function stepPlay(): Promise<void> {
  if (!rewind) return stopPlay();
  if (!rewind.canOlder) { stopPlay(); renderRewind(); return; }
  await rewind.older();
  if (playing()) schedulePlay(); // paused while the page was loading
}

// Pin mode background: the map of the current period's year (rewind + sync), else neutral modern land.
function applyPinBackground(): void {
  if (mode !== 'pin') return;
  const period = pinView === 'rewind' && syncMap ? rewind?.current : undefined;
  const wanted = period ? clampYear(String(period.properties.mapYear ?? period.properties.from), min, max, max) : max;
  for (const l of FILL_LAYERS) map.setPaintProperty(l.id, 'fill-color', period ? ['get', 'color'] : '#e2e2e2');
  if (wanted !== backgroundYear) {
    backgroundYear = wanted;
    setTilesSoon(wanted);
  }
}

const setRegionsLayer = () =>
  map.setLayoutProperty('regions-line', 'visibility', regionsBox.checked && mode === 'year' ? 'visible' : 'none');

function setMode(next: Mode): void {
  mode = next;
  latestClick++;
  panel.hidden = true;
  modeYear.setAttribute('aria-pressed', String(next === 'year'));
  modePin.setAttribute('aria-pressed', String(next === 'pin'));
  controls.hidden = next === 'pin';
  coordsForm.hidden = next !== 'pin';
  coordsError.hidden = true;
  pin.setVisible(next === 'pin');
  stopPlay();
  rewind = null;
  backgroundYear = null;
  if (next === 'pin') {
    applyPinBackground(); // neutral modern land until a place is pinned, so the contours stay readable
    if (backgroundYear !== null) setTiles(backgroundYear);
  } else {
    pin.clear();
    setTiles(year);
    for (const l of FILL_LAYERS) map.setPaintProperty(l.id, 'fill-color', ['get', 'color']);
  }
  setRegionsLayer();
}
modeYear.addEventListener('click', () => setMode('year'));
modePin.addEventListener('click', () => setMode('pin'));

function setYear(next: number): void {
  year = next;
  showYear();
  if (mode === 'year') setTilesSoon(year);
}
slider.addEventListener('input', () => setYear(Number(slider.value)));
yearInput.addEventListener('change', () => setYear(clampYear(yearInput.value, min, max, year)));
let lastClick: { lat: number; lng: number } | null = null;

function setPinView(view: PinView): void {
  pinView = view;
  stopPlay();
  if (lastClick) void lookup(lastClick.lat, lastClick.lng);
}

const rewindHandlers = {
  older: () => { stopPlay(); void rewind?.older(); },
  newer: () => { stopPlay(); rewind?.newer(); },
  goTo: (index: number) => { stopPlay(); rewind?.goTo(index); },
  togglePlay: () => {
    if (playing()) {
      stopPlay();
    } else {
      schedulePlay();
    }
    renderRewind();
  },
  setSync: (sync: boolean) => { syncMap = sync; renderRewind(); },
  setView: setPinView,
  retry: () => void rewind?.retry(),
};

// Shows the current period: its contour on the map and the panel with the steppers and the loaded periods.
function renderRewind(): void {
  if (!rewind || mode !== 'pin' || pinView !== 'rewind') return;
  const current = rewind.current;
  pin.setData({ type: 'FeatureCollection', features: current ? [current] : [] });
  pin.emphasize(true);
  renderRewindPanel(
    panel,
    {
      items: rewind.items, index: rewind.index, total: rewind.total, loading: rewind.loading, error: rewind.error,
      canOlder: rewind.canOlder, canNewer: rewind.canNewer, playing: playing(), sync: syncMap,
    },
    rewindHandlers,
  );
  applyPinBackground();
}

async function lookup(lat: number, lng: number): Promise<void> {
  const id = ++latestClick;
  try {
    if (mode === 'pin') {
      stopPlay();
      pin.place([lng, lat]);
      if (pinView === 'all') {
        rewind = null;
        pin.emphasize(false);
        const history = await fetchHistory(lat, lng, regionsBox.checked);
        if (id !== latestClick) return;
        pin.show([lng, lat], history);
        renderHistoryPanel(panel, history.features, (name) => pin.highlight(name), setPinView);
        applyPinBackground();
      } else {
        const instance: Rewind = new Rewind({
          fetchPage: (offset, limit) => fetchHistoryPage(lat, lng, regionsBox.checked, offset, limit),
          onChange: () => rewind === instance && renderRewind(),
          firstPage: 3, // small, so the newest period shows up quickly; the rest loads in the background
          pageSize: 6,
          prefetchAhead: 2,
        });
        rewind = instance;
        renderRewind();
        await instance.start();
      }
    } else {
      const [at, periods] = await Promise.all([fetchAt(lat, lng, year), fetchTimeline(lat, lng)]);
      if (id !== latestClick) return;
      renderPanel(panel, at, periods, regionsBox.checked);
    }
  } catch {
    if (id !== latestClick) return;
    panel.hidden = false;
    panel.textContent = t.loadFailed;
  }
}

regionsBox.addEventListener('change', () => {
  setRegionsLayer();
  if (lastClick && !panel.hidden) void lookup(lastClick.lat, lastClick.lng); // refresh the open panel
});

map.on('click', (e) => {
  const { lat, lng } = e.lngLat.wrap();
  lastClick = { lat, lng };
  coordsInput.value = `${lat.toFixed(4)}, ${lng.toFixed(4)}`; // handy for copying / editing
  coordsError.hidden = true;
  void lookup(lat, lng);
});

// Pin mode: type coordinates instead of clicking.
coordsInput.addEventListener('input', () => (coordsError.hidden = true));
coordsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const place = parseCoordinates(coordsInput.value);
  if (!place) {
    coordsError.textContent = t.coordsError;
    coordsError.hidden = false;
    return;
  }
  coordsError.hidden = true;
  lastClick = place;
  map.flyTo({ center: [place.lng, place.lat], zoom: Math.max(map.getZoom(), 5) });
  void lookup(place.lat, place.lng);
});
