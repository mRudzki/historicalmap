import { describe, expect, it } from 'vitest';
import { isShareAlike, parseOhmInterval } from './ohm-dates';

describe('parseOhmInterval', () => {
  it('start of a full date is the start of that day, end is the end of that day', () => {
    const r = parseOhmInterval('1871-05-04', '1918-11-11')!;
    expect(r.from).toBeCloseTo(1871 + 123 / 365, 6); // day 124 of 1871 -> 123 full days before
    expect(r.to).toBeCloseTo(1918 + 315 / 365, 6);
  });

  it('expands partial dates: start to the beginning, end to the end of the period', () => {
    expect(parseOhmInterval('1871', '1871')).toEqual({ from: 1871, to: 1872 });
    const m = parseOhmInterval('1871-03', '1871-03')!;
    expect(m.from).toBeCloseTo(1871 + 59 / 365, 6);
    expect(m.to).toBeCloseTo(1871 + 90 / 365, 6);
  });

  it('handles leap years', () => {
    const r = parseOhmInterval('1900-03-01', '2000-03-01')!;
    expect(r.from).toBeCloseTo(1900 + 59 / 365, 6); // 1900 is not a leap year
    expect(r.to).toBeCloseTo(2000 + 61 / 366, 6); // 2000 is
  });

  it('parses negative and unpadded years', () => {
    expect(parseOhmInterval('-0027', '-0019')).toEqual({ from: -27, to: -18 });
    expect(parseOhmInterval('999', undefined)).toEqual({ from: 999, to: null });
  });

  it('a missing or empty end date means open-ended', () => {
    expect(parseOhmInterval('1947', undefined)!.to).toBeNull();
    expect(parseOhmInterval('1947', '')!.to).toBeNull();
  });

  it.each([
    ['unparsable start', 'c. 1500', '1600'],
    ['unparsable end', '1500', 'before 1600'],
    ['missing start', undefined, '1600'],
    ['month 13', '1900-13-01', '1901'],
    ['Feb 30', '1900-02-30', '1901'],
    ['end before start (present in the real data)', '1808-05-24', '1807-12-10'],
    ['end before start within a year', '1900-05-01', '1900-04-30'],
  ])('returns null for %s', (_label, start, end) => {
    expect(parseOhmInterval(start, end)).toBeNull();
  });
});

describe('isShareAlike', () => {
  it.each([
    ['CC-BY-SA-4.0', true],
    ['CC BY-SA 2.0', true],
    ['share-alike', true],
    ['CC0-1.0', false],
    ['CC-BY-4.0', false],
    ['Public domain', false],
    [undefined, false],
  ])('%s -> %s', (license, expected) => {
    expect(isShareAlike(license)).toBe(expected);
  });
});
