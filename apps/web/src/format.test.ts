import { describe, expect, it } from 'vitest';
import { formatYear, polityLabel, tileUrl } from './format';

describe('formatYear', () => {
  it('formats AD and BC years', () => {
    expect(formatYear(1410)).toBe('1410');
    expect(formatYear(-500)).toBe('500 p.n.e.');
  });
});

describe('polityLabel', () => {
  it('translates the unnamed-territory sentinel and keeps other names', () => {
    expect(polityLabel('Unnamed territory')).toBe('Terytorium bez nazwy');
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
