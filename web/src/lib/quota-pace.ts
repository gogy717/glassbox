/**
 * Whether a plan window's use is fine for where the window stands: "35% used" against how much of
 * the window has gone, and when the limit comes at this pace if that is before the reset.
 */
import type { QuotaWindow } from '../../../src/core/model.js';

const HOUR = 3_600_000;
const SESSION_MS = 5 * HOUR;
const WEEK_MS = 7 * 24 * HOUR;
/** Too soon after a reset to say anything: the first 5% of the window. */
const EARLY = 0.05;

export interface Pace {
  /** Share of the window gone, 0..1. */
  elapsed: number;
  /** What the window spans, for "29% of the week gone". */
  span: 'hours5' | 'week' | 'month' | 'window';
  /**
   * 'early': the window has only just reset; 'on-pace': no more used than gone, so the reset
   * comes before the limit; 'limit': the limit comes first, at `limitAt`.
   */
  verdict: 'early' | 'on-pace' | 'limit';
  /** When the limit is reached at the pace so far (epoch ms), for 'limit'; null otherwise. */
  limitAt: number | null;
}

/** The same moment of the calendar month before, in UTC; the 31st of March goes back to 28 February. */
function monthBefore(t: number): number {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Date.UTC(
    y,
    m - 1,
    Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/** The window's length: its source's, else its kind's (a monthly one: the month to its reset). */
function lengthOf(w: QuotaWindow, reset: number): number | null {
  if (w.durationMs !== undefined && w.durationMs > 0) return w.durationMs;
  switch (w.kind) {
    case 'session':
      return SESSION_MS;
    case 'weekly':
    case 'weekly-model':
      return WEEK_MS;
    case 'monthly':
      return reset - monthBefore(reset);
    default:
      return null;
  }
}

function spanOf(w: QuotaWindow, length: number): Pace['span'] {
  switch (w.kind) {
    case 'session':
      return length === SESSION_MS ? 'hours5' : 'window';
    case 'weekly':
    case 'weekly-model':
      return 'week';
    case 'monthly':
      return 'month';
    default:
      return 'window';
  }
}

export type QuotaLevel = 'ok' | 'warn' | 'danger';

/**
 * A window's colour: red from 95%, amber from 80%, and amber below that too when its limit comes
 * before its reset at this pace. Colour is for a limit that is near.
 */
export function quotaLevel(w: QuotaWindow, pace: Pace | null): QuotaLevel {
  if (w.usedPercent >= 95) return 'danger';
  return w.usedPercent >= 80 || pace?.verdict === 'limit' ? 'warn' : 'ok';
}

/**
 * Where `w` stands at `now`: the share of it gone, and the verdict on the share used, judged by
 * the whole percentages shown. Null when there is nothing to judge: stale numbers, no reset time,
 * a window past its reset (its figure is history) or of unknown length, or one at its limit.
 */
export function paceOf(w: QuotaWindow, now: number, stale = false): Pace | null {
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN;
  if (stale || !Number.isFinite(reset) || reset <= now) return null;
  const length = lengthOf(w, reset);
  if (length === null) return null;
  const used = Math.min(100, Math.max(0, w.usedPercent));
  if (used >= 100) return null;
  const start = reset - length;
  const elapsed = Math.min(1, Math.max(0, (now - start) / length));
  const span = spanOf(w, length);
  if (elapsed < EARLY) return { elapsed, span, verdict: 'early', limitAt: null };
  if (Math.round(used) <= Math.round(elapsed * 100))
    return { elapsed, span, verdict: 'on-pace', limitAt: null };
  // More used than gone: at this rate the limit comes before the reset.
  return { elapsed, span, verdict: 'limit', limitAt: start + elapsed * (100 / used) * length };
}
