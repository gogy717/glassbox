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
  middleEllipsis,
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
    // D1: narrow units, a thin space after the figure.
    ['2026-10-23T09:59:30.000Z', '30\u2009s ago'],
    ['2026-10-23T09:57:00.000Z', '3\u2009m ago'],
    ['2026-10-23T08:25:00.000Z', '2\u2009h ago'],
    ['2026-10-22T10:00:00.000Z', 'yesterday'],
    ['2026-10-20T10:00:00.000Z', '3\u2009d ago'],
  ])('%s → %s', (iso, want) => {
    expect(formatRelative(iso, now, 'en')).toBe(want);
  });

  it('uses the locale', () => {
    // No thin space before a CJK unit.
    expect(formatRelative('2026-10-23T09:57:00.000Z', now, 'zh')).toBe('3分钟前');
  });

  it('reads a time a little ahead of this clock as now, never “in 2 seconds”', () => {
    expect(formatRelative('2026-10-23T10:00:02.000Z', now, 'en')).toBe('now');
    expect(formatRelative('2026-10-23T10:05:00.000Z', now, 'zh')).toBe('现在');
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

describe('middleEllipsis', () => {
  it('leaves a path that fits as it is', () => {
    expect(middleEllipsis('src/server/store.ts', 40)).toBe('src/server/store.ts');
    expect(middleEllipsis('src/server/store.ts', 19)).toBe('src/server/store.ts');
  });

  it('keeps the first segment and as many trailing ones as fit', () => {
    const path = 'src/adapters/omp/parser.ts';
    expect(middleEllipsis(path, 25)).toBe('src/…/omp/parser.ts');
    expect(middleEllipsis(path, 18)).toBe('src/…/parser.ts');
    for (const n of [15, 18, 19, 25]) expect(middleEllipsis(path, n).length).toBeLessThanOrEqual(n);
  });

  it('keeps the root of an absolute path and backslashes as written', () => {
    expect(middleEllipsis('/home/user/dev/glassbox/web/src/lib/format.ts', 24)).toBe(
      '/…/web/src/lib/format.ts',
    );
    expect(middleEllipsis('C:\\Users\\user\\dev\\store.ts', 16)).toBe('C:\\…\\store.ts');
  });

  it('falls back to the file name, then to its head and tail', () => {
    expect(middleEllipsis('a/b/c/a-rather-long-file-name.tsx', 30)).toBe(
      '…/a-rather-long-file-name.tsx',
    );
    expect(middleEllipsis('a/b/c/a-rather-long-file-name.tsx', 12)).toBe('a-rat…me.tsx');
    expect(middleEllipsis('just-one-very-long-name.ts', 10)).toBe('just…me.ts');
    expect(middleEllipsis('abc', 1)).toBe('…');
  });
});
