import { useEffect, useState, useSyncExternalStore } from 'react';

/** Wall-clock milliseconds, re-rendering every `intervalMs` so live timers tick. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// One clock for every ticking label on screen: one interval however many there are, and each
// label still re-renders on its own.
let second = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    // The first label on screen: start from now. React reads the clock again after subscribing,
    // so a label that rendered with an older second re-renders at once.
    second = Date.now();
    timer = setInterval(() => {
      second = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || timer === null) return;
    clearInterval(timer);
    timer = null;
  };
}

/**
 * The shared clock's time. Stopped (no label on screen), it catches up with the wall clock
 * before it is read, at most once a second so that two reads in one render agree: a label
 * mounted after a pause starts from now, not from when the last one went away.
 */
function snapshot(): number {
  if (timer === null && Math.abs(Date.now() - second) >= 1000) second = Date.now();
  return second;
}

/** Wall-clock milliseconds from the shared 1 s clock, for labels that count seconds. */
export function useSecond(): number {
  return useSyncExternalStore(subscribe, snapshot);
}
