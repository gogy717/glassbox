import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatCountdown,
  formatDuration,
  formatElapsed,
  formatNumber,
  formatPercent,
  formatRelative,
  formatResetTime,
} from './format';

describe('formatDuration (DSH rule)', () => {
  it.each([
    [null, '—'],
    [Number.NaN, '—'],
    [-5, '—'],
    [0, '0ms'],
    [123, '123ms'],
    [999, '999ms'],
    [1000, '1.0s'],
    [2849, '2.8s'],
    [9949, '9.9s'],
    [10_000, '10s'],
    [35_400, '35s'],
    [59_999, '59s'],
    [60_000, '1m0s'],
    [65_000, '1m5s'],
    [3_599_000, '59m59s'],
    [3_600_000, '1h0m'],
    [3_725_000, '1h2m'],
  ])('%s → %s', (ms, want) => {
    expect(formatDuration(ms)).toBe(want);
  });
});

describe('formatElapsed (live timers)', () => {
  it.each([
    [0, '0:00'],
    [5_400, '0:05'],
    [83_000, '1:23'],
    [360_000, '6:00'],
    [3_599_999, '59:59'],
    [3_600_000, '1:00:00'],
    [3_723_000, '1:02:03'],
  ])('%s → %s', (ms, want) => {
    expect(formatElapsed(ms)).toBe(want);
  });
});

describe('formatNumber / formatPercent', () => {
  it('groups thousands and shows missing values as a dash', () => {
    expect(formatNumber(1_838_850, 'en')).toBe('1,838,850');
    expect(formatNumber(null, 'en')).toBe('—');
  });

  it('formats a 0..1 share with one decimal', () => {
    expect(formatPercent(0.86043, 'en')).toBe('86.0%');
    expect(formatPercent(null, 'en')).toBe('—');
  });
});

describe('formatClock', () => {
  it('shows HH:MM:SS in the given zone, 24-hour', () => {
    expect(formatClock('2026-10-23T09:05:07.900Z', 'UTC')).toBe('09:05:07');
    expect(formatClock('2026-10-23T21:05:07.000Z', 'UTC')).toBe('21:05:07');
  });

  it('shows a dash for a missing or invalid time', () => {
    expect(formatClock(null)).toBe('—');
    expect(formatClock('not a date')).toBe('—');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-10-23T10:00:00.000Z');
  it.each([
    ['2026-10-23T09:59:30.000Z', '30 seconds ago'],
    ['2026-10-23T09:57:00.000Z', '3 minutes ago'],
    ['2026-10-23T08:25:00.000Z', '2 hours ago'],
    ['2026-10-20T10:00:00.000Z', '3 days ago'],
  ])('%s → %s', (iso, want) => {
    expect(formatRelative(iso, now, 'en')).toBe(want);
  });

  it('uses the locale', () => {
    expect(formatRelative('2026-10-23T09:57:00.000Z', now, 'zh')).toMatch(/^3\s?分钟前$/);
  });
});

describe('formatCountdown', () => {
  it.each([
    [-1, null],
    [0, null],
    [45_000, '45s'],
    [5_820_000, '1h37m'],
    [86_400_000, '1d'],
    [3 * 86_400_000 + 5 * 3_600_000, '3d5h'],
  ])('%s → %s', (ms, want) => {
    expect(formatCountdown(ms)).toBe(want);
  });
});

describe('formatResetTime', () => {
  const now = Date.parse('2026-10-23T09:00:00Z');

  it('gives only the time, to the nearest minute, for later today', () => {
    expect(formatResetTime('2026-10-23T15:30:29Z', now, 'en', 'UTC')).toEqual({
      date: null,
      clock: '15:30',
    });
    expect(formatResetTime('2026-10-23T15:30:59Z', now, 'en', 'UTC')).toEqual({
      date: null,
      clock: '15:31',
    });
  });

  it('rounds the sub-second noise of a cached reset onto its boundary, day included', () => {
    // Claude Code's cache gives the same weekly boundary as 23:59:59.9 or as 00:00:00.15.
    for (const iso of ['2026-10-27T23:59:59.912Z', '2026-10-28T00:00:00.152Z'])
      expect(formatResetTime(iso, now, 'en', 'UTC')).toEqual({
        date: 'Wed, Oct 28',
        clock: '00:00',
      });
  });

  it('adds the day for any other day, in the UI language', () => {
    expect(formatResetTime('2026-10-28T11:00:00Z', now, 'en', 'UTC')).toEqual({
      date: 'Wed, Oct 28',
      clock: '11:00',
    });
    expect(formatResetTime('2026-10-28T11:00:00Z', now, 'zh-CN', 'UTC')).toEqual({
      date: '10月28日周三',
      clock: '11:00',
    });
  });

  it('counts just past midnight as another day', () => {
    expect(formatResetTime('2026-10-24T00:10:00Z', now, 'en', 'UTC').date).toBe('Sat, Oct 24');
  });
});
