import * as maplibregl from 'maplibre-gl';
import type { LayerSpecification } from 'maplibre-gl';
import type { HistoryCollection } from './api';

export const HISTORY_SOURCE = 'history';
export const emptyHistory: HistoryCollection = { type: 'FeatureCollection', features: [] };

const hidden = { visibility: 'none' } as const;

// Contours of every polity that held the pinned place: faint fill, clear outline, and a
// thick highlight line for the polity hovered in the panel. Hidden until pin mode is on.
export const historyLayers: LayerSpecification[] = [
  {
    id: 'history-fill', type: 'fill', source: HISTORY_SOURCE, layout: hidden,
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['==', ['get', 'level'], 2], 0.15, 0.06] },
  },
  {
    id: 'history-line', type: 'line', source: HISTORY_SOURCE, layout: hidden,
    paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['==', ['get', 'level'], 2], 1.5, 0.8] },
  },
  {
    id: 'history-highlight', type: 'line', source: HISTORY_SOURCE, layout: hidden,
    filter: ['==', ['get', 'name'], ''],
    paint: { 'line-color': ['get', 'color'], 'line-width': 4 },
  },
];

export class PinLayer {
  private marker = new maplibregl.Marker({ color: '#d33' });

  constructor(private map: maplibregl.Map) {}

  private source() {
    return this.map.getSource(HISTORY_SOURCE) as maplibregl.GeoJSONSource;
  }

  setVisible(visible: boolean): void {
    for (const l of historyLayers) {
      this.map.setLayoutProperty(l.id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  show(lngLat: maplibregl.LngLatLike, data: HistoryCollection): void {
    this.marker.setLngLat(lngLat).addTo(this.map);
    this.source().setData(data as never);
    this.highlight(null);
  }

  highlight(name: string | null): void {
    this.map.setFilter('history-highlight', ['==', ['get', 'name'], name ?? '']);
  }

  clear(): void {
    this.marker.remove();
    this.source().setData(emptyHistory as never);
    this.highlight(null);
  }
}
