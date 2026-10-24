/**
 * The weekly receipt's dialog over the page's week cache (R30, `data/weeks.ts`): a window it
 * shows is read again the first time it shows it, once while it stays open, and the reads it
 * holds stop when it closes, unless something else on the page still shows that window. A window
 * read before, by the dialog or the Stats page, shows at once while it is read again.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { WeekResult, WeekWindowKind } from '../../../../src/shared/week.js';
import { useWeekCache, useWeeksOf } from '../../data/store';

export { readWeek } from '../../data/readWeek';

/** One window's data: being read (how far), read, or not readable. */
export type WeekState =
  | { phase: 'reading'; done: number; total: number }
  | { phase: 'ready'; result: WeekResult }
  | { phase: 'failed'; msg: string };

type PerWindow<T> = Partial<Record<WeekWindowKind, T>>;

const WINDOWS: WeekWindowKind[] = ['week', '7d'];

/** The windows the dialog shows, as they are read. */
export function useWeeks() {
  const cache = useWeekCache();
  const weeks = useWeeksOf(cache);
  const held = useRef(new Map<WeekWindowKind, () => void>());
  useEffect(() => {
    const mine = held.current;
    return () => {
      for (const release of mine.values()) release();
      // Mounted again (StrictMode does), every window is read again.
      mine.clear();
    };
  }, []);

  const read = useCallback(
    (kind: WeekWindowKind, refresh: boolean) => cache.request(kind, { refresh }),
    [cache],
  );

  /** Shows `kind`: read again the first time, and held while the dialog is open. */
  const ensure = useCallback(
    (kind: WeekWindowKind) => {
      if (held.current.has(kind)) return;
      held.current.set(kind, cache.retain(kind));
      cache.request(kind);
    },
    [cache],
  );

  // A window with a result is ready while it is read again: a refresh says how far it got, any
  // other read only that it is updating; a failure then is the refresh's, the result stays.
  const derived = useMemo(() => {
    const states: PerWindow<WeekState> = {};
    const refreshing: PerWindow<{ done: number; total: number }> = {};
    const updating: PerWindow<boolean> = {};
    const refreshFailed: PerWindow<string> = {};
    for (const kind of WINDOWS) {
      const e = weeks[kind];
      if (!e) continue;
      if (e.result) {
        states[kind] = { phase: 'ready', result: e.result };
        if (e.reading?.refresh) refreshing[kind] = { done: e.reading.done, total: e.reading.total };
        else if (e.reading) updating[kind] = true;
        if (e.failed !== null) refreshFailed[kind] = e.failed;
      } else if (e.reading) {
        states[kind] = { phase: 'reading', done: e.reading.done, total: e.reading.total };
      } else if (e.failed !== null) {
        states[kind] = { phase: 'failed', msg: e.failed };
      }
    }
    return { states, refreshing, updating, refreshFailed };
  }, [weeks]);

  return { ...derived, ensure, read };
}
