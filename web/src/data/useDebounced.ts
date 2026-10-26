import { useEffect, useState } from 'react';

/**
 * `value` once it has held for `ms`: the first value passes at once, each later one when no
 * newer one has come for `ms`. For work worth doing on what was typed, not on every key.
 */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}
