import { describe, expect, it } from 'vitest';
import { absoluteUrl, clampYear, formatYear, parseCoordinates, polityLabel, tileUrl } from './format';

describe('formatYear', () => {
  it('formats AD and BC years', () => {
    expect(formatYear(1410)).toBe('1410');
    expect(formatYear(-500)).toBe('500 BC');
  });
});

describe('polityLabel', () => {
  it('shows the unnamed-territory sentinel as "Lack of data" and keeps other names', () => {
    expect(polityLabel('Unnamed territory')).toBe('Lack of data');
    expect(polityLabel('Teutonic Knights')).toBe('Teutonic Knights');
  });
});

describe('tileUrl', () => {
  it('builds a MapLibre tile template with the year', () => {
    expect(tileUrl('http://localhost:3100', 1400)).toBe(
      'http://localhost:3100/polities_tile/{z}/{x}/{y}?year=1400',
    );
  });
});

describe('clampYear', () => {
  it('parses, truncates and clamps to the range', () => {
    expect(clampYear('1871', 1000, 2026, 2026)).toBe(1871);
    expect(clampYear('1871.9', 1000, 2026, 2026)).toBe(1871);
    expect(clampYear('5', 1000, 2026, 2026)).toBe(1000);
    expect(clampYear('9999', 1000, 2026, 2026)).toBe(2026);
  });
  it('keeps the fallback for non-numeric input', () => {
    expect(clampYear('', 1000, 2026, 1500)).toBe(1500);
    expect(clampYear('abc', 1000, 2026, 1500)).toBe(1500);
  });
});

describe('parseCoordinates', () => {
  it.each([
    ['54.35, 18.65'],
    ['54.35 18.65'],
    ['54.35;18.65'],
    ['  54.35 ,18.65  '],
    ['54.35N 18.65E'],
    ['54.35° N, 18.65° E'],
  ])('parses %j', (text) => {
    expect(parseCoordinates(text)).toEqual({ lat: 54.35, lng: 18.65 });
  });

  it('uses S and W hemispheres and plain negatives for southern and western places', () => {
    expect(parseCoordinates('54.35 S, 18.65 W')).toEqual({ lat: -54.35, lng: -18.65 });
    expect(parseCoordinates('-33.9, 151.2')).toEqual({ lat: -33.9, lng: 151.2 });
  });

  it('accepts the extreme valid values', () => {
    expect(parseCoordinates('90, 180')).toEqual({ lat: 90, lng: 180 });
    expect(parseCoordinates('-90, -180')).toEqual({ lat: -90, lng: -180 });
  });

  it.each([
    ['empty', ''],
    ['text', 'abc'],
    ['one number', '54.35'],
    ['latitude out of range', '91, 0'],
    ['longitude out of range', '0, 181'],
    ['decimal commas (ambiguous)', '54,35 18,65'],
    ['hemispheres in the wrong order', '54.35 E 18.65 N'],
    ['sign and hemisphere together', '-54.35 S, 18.65 E'],
    ['exponent notation', '1e1, 2'],
    ['three numbers', '1, 2, 3'],
  ])('rejects %s', (_label, text) => {
    expect(parseCoordinates(text)).toBeNull();
  });
});

describe('absoluteUrl', () => {
  it('prefixes a path with the page origin (MapLibre needs absolute tile URLs)', () => {
    expect(absoluteUrl('/tiles', 'https://example.org')).toBe('https://example.org/tiles');
  });
  it('leaves full URLs alone', () => {
    expect(absoluteUrl('http://localhost:3100', 'https://example.org')).toBe('http://localhost:3100');
  });
});
