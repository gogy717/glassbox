/**
 * Reading `/api/week` for the weekly receipt's dialog: the NDJSON stream to its result, and the
 * windows read so far, each once until asked again, every request aborted when the dialog closes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type WeekLine,
  type WeekResult,
  type WeekWindowKind,
  weekPath,
} from '../../../../src/shared/week.js';

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

/** One window's data: being read (how far), read, or not readable. */
export type WeekState =
  | { phase: 'reading'; done: number; total: number }
  | { phase: 'ready'; result: WeekResult }
  | { phase: 'failed'; msg: string };

/** The windows the dialog has asked for, as they are read. */
export function useWeeks() {
  const [states, setStates] = useState<Partial<Record<WeekWindowKind, WeekState>>>({});
  const [refreshing, setRefreshing] = useState<{ done: number; total: number } | null>(null);
  const [refreshFailed, setRefreshFailed] = useState<string | null>(null);
  const aborts = useRef(new Set<AbortController>());
  const asked = useRef(new Set<WeekWindowKind>());
  useEffect(() => {
    const live = aborts.current;
    const wanted = asked.current;
    return () => {
      for (const abort of live) abort.abort();
      // Mounted again (StrictMode does), every window is read again.
      wanted.clear();
    };
  }, []);

  const read = useCallback((kind: WeekWindowKind, refresh: boolean) => {
    const abort = new AbortController();
    aborts.current.add(abort);
    const set = (s: WeekState) => setStates((all) => ({ ...all, [kind]: s }));
    if (refresh) {
      setRefreshFailed(null);
      setRefreshing({ done: 0, total: 0 });
    } else set({ phase: 'reading', done: 0, total: 0 });
    readWeek(
      kind,
      refresh,
      (done, total) =>
        refresh ? setRefreshing({ done, total }) : set({ phase: 'reading', done, total }),
      abort.signal,
    )
      .then((result) => set({ phase: 'ready', result }))
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (refresh) setRefreshFailed(msg);
        else set({ phase: 'failed', msg });
      })
      .finally(() => {
        aborts.current.delete(abort);
        if (refresh) setRefreshing(null);
      });
  }, []);

  /** Reads `kind` unless it was asked for already. */
  const ensure = useCallback(
    (kind: WeekWindowKind) => {
      if (asked.current.has(kind)) return;
      asked.current.add(kind);
      read(kind, false);
    },
    [read],
  );

  return { states, refreshing, refreshFailed, ensure, read };
}
