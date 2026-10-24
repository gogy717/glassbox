import { useEffect } from 'react';
import type { WeekWindowKind } from '../../../../src/shared/week.js';
import { useWeekCache, useWeeksOf } from '../../data/store';
import type { WeekEntry } from '../../data/weeks';

/** How often the page reads its week again while it is on screen. */
export const POLL_MS = 60_000;

const NONE: WeekEntry = { result: null, reading: null, failed: null };

/**
 * The week the Stats page shows (R30): read on every visit, and every minute while the page is on
 * screen and its tab visible (at once on coming back to the tab), never while a read of it is
 * under way; what was read before shows meanwhile. Its reads stop when the page goes.
 */
export function useStatsWeek(kind: WeekWindowKind): WeekEntry {
  const cache = useWeekCache();
  const weeks = useWeeksOf(cache);
  useEffect(() => {
    const release = cache.retain(kind);
    const read = () => cache.request(kind);
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== 'visible') return;
      read();
      timer = setInterval(read, POLL_MS);
    };
    tick();
    document.addEventListener('visibilitychange', tick);
    return () => {
      document.removeEventListener('visibilitychange', tick);
      clearInterval(timer);
      release();
    };
  }, [cache, kind]);
  return weeks[kind] ?? NONE;
}
