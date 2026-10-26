import { describe, expect, it } from 'vitest';
import type { QuotaWindow } from '../../../src/core/model.js';
import { paceOf } from './quota-pace';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-22T12:00:00Z');
const iso = (t: number) => new Date(t).toISOString();

/** A weekly window that resets `left` ms from now, `used` percent used. */
const weekly = (used: number, left: number, over: Partial<QuotaWindow> = {}): QuotaWindow => ({
  id: 'seven_day',
  kind: 'weekly',
  label: null,
  model: null,
  usedPercent: used,
  resetsAt: iso(NOW + left),
  ...over,
});

describe('paceOf', () => {
  it('compares the share used with the share of the window gone', () => {
    // Two of seven days gone: 29%. 20% used is on pace.
    expect(paceOf(weekly(20, 5 * DAY), NOW)).toEqual({
      elapsed: 2 / 7,
      span: 'week',
      verdict: 'on-pace',
      limitAt: null,
    });
  });

  it('is on pace exactly on pace, and at 0% used', () => {
    expect(paceOf(weekly(50, 3.5 * DAY), NOW)?.verdict).toBe('on-pace');
    expect(paceOf(weekly(0, 3.5 * DAY), NOW)?.verdict).toBe('on-pace');
  });

  it('forecasts the limit before the reset: start + elapsed × 100 / used × length', () => {
    // 3.5 of 7 days gone, 70% used: the limit at 0.5 × 100/70 of the week, 5 days in.
    const pace = paceOf(weekly(70, 3.5 * DAY), NOW);
    const start = NOW - 3.5 * DAY;
    expect(pace).toMatchObject({ elapsed: 0.5, span: 'week', verdict: 'limit' });
    expect(pace?.limitAt).toBeCloseTo(start + 5 * DAY, -3);
  });

  it('judges by the percentages as shown: 50.4% used half way is on pace', () => {
    expect(paceOf(weekly(50.4, 3.5 * DAY), NOW)?.verdict).toBe('on-pace');
    expect(paceOf(weekly(50.6, 3.5 * DAY), NOW)?.verdict).toBe('limit');
  });

  it('says nothing yet in the first 5% of a window, however much is used', () => {
    // Five hours into a week is 3%: just reset.
    expect(paceOf(weekly(40, 7 * DAY - 5 * HOUR), NOW)).toEqual({
      elapsed: 5 / 168,
      span: 'week',
      verdict: 'early',
      limitAt: null,
    });
    expect(paceOf(weekly(40, 7 * DAY - 9 * HOUR), NOW)?.verdict).toBe('limit');
  });

  it('has no pace past the reset, without a reset time, for stale numbers, or at the limit', () => {
    expect(paceOf(weekly(70, -1), NOW)).toBeNull();
    expect(paceOf(weekly(70, 0), NOW)).toBeNull();
    expect(paceOf(weekly(70, 3 * DAY, { resetsAt: null }), NOW)).toBeNull();
    expect(paceOf(weekly(70, 3 * DAY, { resetsAt: 'soon' }), NOW)).toBeNull();
    expect(paceOf(weekly(70, 3 * DAY), NOW, true)).toBeNull();
    expect(paceOf(weekly(100, 3 * DAY), NOW)).toBeNull();
  });

  it('times a 5-hour window by its kind, and any window by the length its source gives', () => {
    const session = weekly(30, 2 * HOUR, { id: 'five_hour', kind: 'session' });
    expect(paceOf(session, NOW)).toMatchObject({ elapsed: 0.6, span: 'hours5' });
    // Codex's hour-long window is a 'session' by kind, but an hour long.
    const hour = weekly(30, 15 * 60_000, { kind: 'session', durationMs: HOUR });
    expect(paceOf(hour, NOW)).toMatchObject({ elapsed: 0.75, span: 'window' });
    const other = weekly(30, 2 * HOUR, { kind: 'other', durationMs: 5 * HOUR });
    expect(paceOf(other, NOW)).toMatchObject({ elapsed: 0.6, span: 'window' });
    expect(paceOf(weekly(30, 2 * HOUR, { kind: 'weekly-model' }), NOW)?.span).toBe('week');
  });

  it('has no pace for a window of unknown length', () => {
    expect(paceOf(weekly(30, 2 * HOUR, { kind: 'other' }), NOW)).toBeNull();
    expect(paceOf(weekly(30, 2 * HOUR, { kind: 'other', durationMs: 0 }), NOW)).toBeNull();
  });

  it('takes a monthly window without a length as the calendar month ending at its reset', () => {
    // October has 31 days: on the 16th at 12:00 UTC, half of it is gone.
    const october = weekly(40, 0, { kind: 'monthly', resetsAt: '2026-11-01T00:00:00Z' });
    expect(paceOf(october, Date.parse('2026-10-16T12:00:00Z'))).toMatchObject({
      elapsed: 0.5,
      span: 'month',
      verdict: 'on-pace',
    });
    // A reset on 31 March: the month before has no 31st, so it starts on 28 February.
    const march = weekly(40, 0, { kind: 'monthly', resetsAt: '2026-03-31T00:00:00Z' });
    expect(paceOf(march, Date.parse('2026-03-15T12:00:00Z'))?.elapsed).toBe(15.5 / 31);
    // A length from the source wins over the calendar.
    const days30 = weekly(40, 0, {
      kind: 'monthly',
      resetsAt: '2026-11-01T00:00:00Z',
      durationMs: 30 * DAY,
    });
    expect(paceOf(days30, Date.parse('2026-10-17T00:00:00Z'))?.elapsed).toBe(0.5);
  });

  it('reads a reset further away than the window is long as the window just starting', () => {
    const odd = weekly(30, 8 * DAY);
    expect(paceOf(odd, NOW)).toMatchObject({ elapsed: 0, verdict: 'early' });
  });
});
