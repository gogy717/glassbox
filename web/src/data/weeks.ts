/**
 * The week (`/api/week`), one entry per window, kept for the whole page: the Stats page and the
 * weekly receipt read the same results (R30). A window is read again when asked, never twice at
 * once, and a read stops once nothing on the page shows its window any more.
 */
import {
  type WeekLine,
  type WeekResult,
  type WeekWindowKind,
  weekPath,
} from '../../../src/shared/week.js';

/** `/api/week` read to its result, `onProgress` told how far it got on the way. */
export async function readWeek(
  kind: WeekWindowKind,
  refresh: boolean,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<WeekResult> {
  const res = await fetch(weekPath(kind, refresh), { signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: WeekResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const text = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      // A blank line (a keep-alive, or a proxy's) says nothing.
      if (!text) continue;
      const line = JSON.parse(text) as WeekLine;
      if (line.type === 'progress') onProgress(line.done, line.total);
      else if (line.type === 'result') result = line.result;
      else throw new Error(line.error);
    }
    if (done) break;
  }
  if (!result) throw new Error('no result');
  return result;
}

export type ReadWeek = typeof readWeek;

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
   * Reads `kind` again, unless a read of it is under way. `refresh` has the server parse the
   * running sessions it parsed less than 30 s ago as well.
   */
  request(kind: WeekWindowKind, opts?: { refresh?: boolean }): void;
  /** Something on the page shows `kind`: its reads go on until the last such thing lets go. */
  retain(kind: WeekWindowKind): () => void;
}

const NONE: WeekEntry = { result: null, reading: null, failed: null };

export function createWeekCache(read: ReadWeek = readWeek): WeekCache {
  let weeks: Weeks = {};
  const listeners = new Set<() => void>();
  const users = new Map<WeekWindowKind, number>();
  const reads = new Map<WeekWindowKind, AbortController>();
  const update = (kind: WeekWindowKind, change: Partial<WeekEntry>) => {
    weeks = { ...weeks, [kind]: { ...(weeks[kind] ?? NONE), ...change } };
    for (const fn of [...listeners]) fn();
  };
  return {
    get: () => weeks,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    request(kind, opts = {}) {
      if (reads.has(kind)) return;
      const refresh = opts.refresh === true;
      const abort = new AbortController();
      reads.set(kind, abort);
      update(kind, { reading: { done: 0, total: 0, refresh }, failed: null });
      const live = () => !abort.signal.aborted;
      read(
        kind,
        refresh,
        (done, total) => live() && update(kind, { reading: { done, total, refresh } }),
        abort.signal,
      )
        .then((result) => live() && update(kind, { result, reading: null }))
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
        const abort = reads.get(kind);
        if (!abort) return;
        abort.abort();
        reads.delete(kind);
        update(kind, { reading: null });
      };
    },
  };
}
