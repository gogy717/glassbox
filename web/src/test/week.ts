import { createDemoSnapshot } from '../../../src/core/fixtures/demo.js';
import type { SessionSnapshot } from '../../../src/core/model.js';
import { sessionBuckets, sliceSession, weekWindow } from '../../../src/server/week-buckets.js';
import { createDemoWeek } from '../../../src/server/week-demo.js';
import type { WeekResult, WeekSession, WeekWindowKind } from '../../../src/shared/week.js';

/** A Saturday evening: this week runs Monday 19 to now, the last 7 days from Saturday 17. */
export const WEEK_NOW = new Date(2026, 9, 24, 20, 41).getTime();

/** `/api/week`'s result for `snaps` as the server would slice them, at `now`. */
export function weekResult(
  snaps: SessionSnapshot[],
  kind: WeekWindowKind = 'week',
  now = WEEK_NOW,
): WeekResult {
  const window = weekWindow(kind, now);
  const sessions = snaps
    .map((s) => sliceSession(sessionBuckets(s, now), window))
    .filter((s): s is WeekSession => s !== null)
    .sort((a, b) => b.inWindow.activeMs - a.inWindow.activeMs);
  return {
    window,
    sessions,
    asOf: now,
    stats: { considered: snaps.length, read: snaps.length, cached: 0, failed: 0, bytes: 0, ms: 0 },
  };
}

/** The demo's week: its live session and the synthetic week behind the weekly receipt. */
export const demoWeek = (kind: WeekWindowKind = 'week', now = WEEK_NOW) =>
  weekResult([createDemoSnapshot(new Date(now)), ...createDemoWeek(now)], kind, now);
