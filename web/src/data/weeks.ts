/**
 * The week (`/api/week`), one entry per window, kept for the whole page: the Stats page and the
 * weekly receipt read the same results (R30). A window is read again when asked, never twice at
 * once, and a read stops once nothing on the page shows its window any more.
 */
import type { WeekResult, WeekWindowKind } from '../../../src/shared/week.js';
import type { readWeek } from './readWeek';

export type ReadWeek = typeof readWeek;

/** The reader, loaded with the first read: the first load has no need of it. */
const readLater: ReadWeek = (kind, refresh, onProgress, signal) =>
  import('./readWeek').then((m) => m.readWeek(kind, refresh, onProgress, signal));

/** One window: its last result, a read under way (how far), and why the last read failed. */
export interface WeekEntry {
  /** Kept while it is read again, and when that fails: an honest picture of when it was. */
  result: WeekResult | null;
  reading: { done: number; total: number; refresh: boolean } | null;
  failed: string | null;
}

export type Weeks = Partial<Record<WeekWindowKind, WeekEntry>>;

export interface WeekCache {
  /** Every window asked for so far; a new object whenever one changes. */
  get(): Weeks;
  subscribe(fn: () => void): () => void;
  /**
   * Reads `kind` again. While a read of it is under way, a plain request is passed over and a
   * refresh waits for that read to end, then runs (M5), unless nothing shows the window by then.
   * `refresh` has the server parse the running sessions it parsed less than 30 s ago as well.
   */
  request(kind: WeekWindowKind, opts?: { refresh?: boolean }): void;
  /** Something on the page shows `kind`: its reads go on until the last such thing lets go. */
  retain(kind: WeekWindowKind): () => void;
}

const NONE: WeekEntry = { result: null, reading: null, failed: null };

export function createWeekCache(read: ReadWeek = readLater): WeekCache {
  let weeks: Weeks = {};
  const listeners = new Set<() => void>();
  const users = new Map<WeekWindowKind, number>();
  const reads = new Map<WeekWindowKind, AbortController>();
  // A refresh asked while its window was being read: it runs once that read is done (M5).
  const queued = new Set<WeekWindowKind>();
  const update = (kind: WeekWindowKind, change: Partial<WeekEntry>) => {
    weeks = { ...weeks, [kind]: { ...(weeks[kind] ?? NONE), ...change } };
    for (const fn of [...listeners]) fn();
  };
  const cache: WeekCache = {
    get: () => weeks,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    request(kind, opts = {}) {
      const refresh = opts.refresh === true;
      if (reads.has(kind)) {
        if (refresh) queued.add(kind);
        return;
      }
      const abort = new AbortController();
      reads.set(kind, abort);
      // A failure stays said while the week is read again, until a read succeeds (M4).
      update(kind, { reading: { done: 0, total: 0, refresh } });
      const live = () => !abort.signal.aborted;
      read(
        kind,
        refresh,
        (done, total) => live() && update(kind, { reading: { done, total, refresh } }),
        abort.signal,
      )
        .then((result) => live() && update(kind, { result, reading: null, failed: null }))
        .catch(
          (err: unknown) =>
            live() &&
            update(kind, {
              reading: null,
              failed: err instanceof Error ? err.message : String(err),
            }),
        )
        .finally(() => {
          if (reads.get(kind) === abort) reads.delete(kind);
          if (live() && queued.delete(kind)) cache.request(kind, { refresh: true });
        });
    },
    retain(kind) {
      users.set(kind, (users.get(kind) ?? 0) + 1);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        const left = (users.get(kind) ?? 1) - 1;
        if (left > 0) {
          users.set(kind, left);
          return;
        }
        users.delete(kind);
        queued.delete(kind);
        const abort = reads.get(kind);
        if (!abort) return;
        abort.abort();
        reads.delete(kind);
        update(kind, { reading: null });
      };
    },
  };
  return cache;
}
