import { useEffect, useRef, useState } from 'react';

/**
 * `value`, updated at most once per `ms`: the first value passes at once, later ones land at the
 * end of the interval with whatever is newest. For views too heavy to rebuild on every patch.
 */
export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  // The first value counts as an emission, so the interval starts at mount.
  const last = useRef<number | null>(null);
  if (last.current === null) last.current = Date.now();
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const wait = (last.current ?? 0) + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setShown(value);
      return;
    }
    const id = setTimeout(() => {
      last.current = Date.now();
      setShown(latest.current);
    }, wait);
    return () => clearTimeout(id);
  }, [value, shown, ms]);
  return shown;
}
