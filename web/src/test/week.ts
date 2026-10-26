import { createDemoSnapshot } from '../../../src/core/fixtures/demo.js';
import type { RepoIdentity, SessionSnapshot } from '../../../src/core/model.js';
import { sessionBuckets, sliceSession } from '../../../src/server/week-buckets.js';
import { createDemoWeek, demoRepo } from '../../../src/server/week-demo.js';
import {
  type WeekResult,
  type WeekSession,
  type WeekWindowKind,
  weekWindow,
} from '../../../src/shared/week.js';

/**
 * A Saturday evening: this week runs Monday 16 November to now, the last 7 days from Saturday 14
 * at 21:00. No common time zone changes its clocks in that fortnight, so the tests hold anywhere.
 */
export const WEEK_NOW = new Date(2026, 10, 21, 20, 41).getTime();

/**
 * `/api/week`'s result for `snaps` as the server would slice them, at `now`; each session's
 * repository by `repoOf`, as the server's lookup gives it, when one is given.
 */
export function weekResult(
  snaps: SessionSnapshot[],
  kind: WeekWindowKind = 'week',
  now = WEEK_NOW,
  repoOf?: (cwd: string) => RepoIdentity | null,
): WeekResult {
  const window = weekWindow(kind, now);
  const sessions = snaps
    .map((s) => sliceSession(sessionBuckets(s, now), window, s.session.tags ?? []))
    .filter((s): s is WeekSession => s !== null)
    .map((s) => (repoOf && s.cwd ? { ...s, repo: repoOf(s.cwd) } : s))
    .sort(
      (a, b) =>
        b.inWindow.agentMs - a.inWindow.agentMs || b.inWindow.activeMs - a.inWindow.activeMs,
    );
  return {
    window,
    sessions,
    asOf: now,
    stats: { considered: snaps.length, read: snaps.length, cached: 0, failed: 0, bytes: 0, ms: 0 },
  };
}

/**
 * The demo's week: its live session and the synthetic week behind the weekly receipt, each
 * session's repository as the demo server reads it.
 */
export const demoWeek = (kind: WeekWindowKind = 'week', now = WEEK_NOW) =>
  weekResult([createDemoSnapshot(new Date(now)), ...createDemoWeek(now)], kind, now, demoRepo);
