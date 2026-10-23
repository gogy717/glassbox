import { useCallback, useEffect, useState } from 'react';

export type FetchState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; message: string };

/**
 * Loads `fetcher` whenever `key` changes (null = do nothing). Aborts on change/unmount so a slow
 * answer for an old key never overwrites the new one. `retry` loads again.
 */
export function useFetch<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
): [FetchState<T>, () => void] {
  const [state, setState] = useState<FetchState<T>>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key identifies the fetcher
  useEffect(() => {
    if (key === null) {
      setState({ status: 'idle' });
      return;
    }
    const ctl = new AbortController();
    setState({ status: 'loading' });
    fetcher(ctl.signal).then(
      (data) => !ctl.signal.aborted && setState({ status: 'ok', data }),
      (e: unknown) =>
        !ctl.signal.aborted &&
        setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
    return () => ctl.abort();
  }, [key, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, retry];
}
