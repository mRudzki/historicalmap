import { describe, expect, it } from 'vitest';
import { clampYear, formatYear, polityLabel, tileUrl } from './format';

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
