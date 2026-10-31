/**
 * "Who used it": the server's list of the sessions that used a provider's plan window
 * (`src/shared/quota-burn.ts`), read when asked and again as `tick` moves, the last answer kept
 * meanwhile so a list does not blink while it is read again.
 */
import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { QuotaProvider, SessionSummary } from '../../../src/core/model.js';
import type { ApiErrorResponse } from '../../../src/shared/protocol.js';
import { burnPath, type QuotaBurn } from '../../../src/shared/quota-burn.js';
import { StoreContext } from './store';

export async function fetchQuotaBurn(
  provider: QuotaProvider,
  since: number,
  signal?: AbortSignal,
): Promise<QuotaBurn> {
  const res = await fetch(burnPath(provider, since), { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorResponse | null;
    throw new Error(body?.error ?? res.statusText);
  }
  return (await res.json()) as QuotaBurn;
}

export type BurnState =
  | { status: 'off' }
  | { status: 'reading' }
  | { status: 'ok'; burn: QuotaBurn }
  | { status: 'error' };

/** A list asked for: a provider's window from `since` (epoch ms). */
export interface BurnAsk {
  provider: QuotaProvider;
  since: number;
}

/**
 * The list of each window asked for, by provider, read while `on` (each time it turns on), and
 * again whenever `tick` changes; the last answer for a window is kept while it is read again, and
 * an answer for another window is never shown for this one.
 */
export function useQuotaBurns(
  asks: readonly BurnAsk[],
  on: boolean,
  tick = 0,
): ReadonlyMap<QuotaProvider, BurnState> {
  const [states, setStates] = useState<ReadonlyMap<string, BurnState>>(new Map());
  const paths = asks.map((a) => burnPath(a.provider, a.since));
  const key = on ? paths.join(' ') : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the asks; `tick` asks again
  useEffect(() => {
    if (key === '') return;
    const ctl = new AbortController();
    for (const a of asks) {
      const path = burnPath(a.provider, a.since);
      const set = (state: BurnState) =>
        !ctl.signal.aborted && setStates((was) => new Map(was).set(path, state));
      fetchQuotaBurn(a.provider, a.since, ctl.signal).then(
        (burn) => set({ status: 'ok', burn }),
        () =>
          !ctl.signal.aborted &&
          setStates((was) =>
            // A failed read again keeps the list it had.
            was.get(path)?.status === 'ok' ? was : new Map(was).set(path, { status: 'error' }),
          ),
      );
    }
    return () => ctl.abort();
  }, [key, tick]);
  return new Map(
    asks.map((a, i) => [
      a.provider,
      on ? (states.get(paths[i] as string) ?? { status: 'reading' }) : { status: 'off' },
    ]),
  );
}

const noSubscription = () => () => {};
const NO_SESSIONS: SessionSummary[] = [];

/**
 * The ids of the sessions the session list has, which a row may link to (a session not listed
 * has no page to open); null outside a store, where every row links.
 */
export function useListedIds(): ReadonlySet<string> | null {
  const store = useContext(StoreContext);
  const sessions = useSyncExternalStore(store ? store.subscribe : noSubscription, () =>
    store ? store.getState().sessions : NO_SESSIONS,
  );
  return useMemo(() => (store ? new Set(sessions.map((s) => s.id)) : null), [store, sessions]);
}
