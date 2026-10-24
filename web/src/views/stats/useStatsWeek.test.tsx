import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WeekWindowKind } from '../../../../src/shared/week.js';
import { createStore, StoreContext } from '../../data/store';
import { POLL_MS, useStatsWeek } from './useStatsWeek';

/** fetch for /api/week, every read held open: the URLs asked for, and their signals. */
function held() {
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => {});
    }),
  );
  return { calls, signals };
}

function Probe({ kind }: { kind: WeekWindowKind }) {
  useStatsWeek(kind);
  return null;
}

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() =>
    hidden ? 'hidden' : 'visible',
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const visibility = (to: 'hidden' | 'visible') =>
  act(() => {
    hidden = to === 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });

/** Moves the clock on, letting each read get as far as its fetch (the reader loads on first use). */
const tick = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('the week the Stats page shows (R30)', () => {
  it('is read on every visit, and not again while that read is under way', async () => {
    const { calls } = held();
    const store = createStore();
    const page = () => (
      <StoreContext.Provider value={store}>
        <Probe kind="week" />
      </StoreContext.Provider>
    );
    const first = render(page());
    await vi.waitFor(() => expect(calls).toEqual(['/api/week?window=week']));
    await tick(POLL_MS);
    // The tick found the visit's read still going: no second one.
    expect(calls).toHaveLength(1);
    first.unmount();
    render(page());
    await vi.waitFor(() =>
      expect(calls).toEqual(['/api/week?window=week', '/api/week?window=week']),
    );
  });

  it('is read every minute while the tab is visible, and not while it is hidden', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response('nope', { status: 500 });
      }),
    );
    render(
      <StoreContext.Provider value={createStore()}>
        <Probe kind="7d" />
      </StoreContext.Provider>,
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await tick(POLL_MS);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    visibility('hidden');
    await tick(5 * POLL_MS);
    expect(calls).toHaveLength(2);
    // Back on the tab: read now, then every minute again.
    visibility('visible');
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    await tick(POLL_MS);
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls.every((c) => c === '/api/week?window=7d')).toBe(true);
  });

  it('stops reading, and stops its clock, when the page goes or shows the other window', async () => {
    const { calls, signals } = held();
    const store = createStore();
    const page = (kind: WeekWindowKind) => (
      <StoreContext.Provider value={store}>
        <Probe kind={kind} />
      </StoreContext.Provider>
    );
    const { rerender, unmount } = render(page('week'));
    await vi.waitFor(() => expect(calls).toEqual(['/api/week?window=week']));
    rerender(page('7d'));
    await vi.waitFor(() => expect(calls).toEqual(['/api/week?window=week', '/api/week?window=7d']));
    expect(signals[0]?.aborted).toBe(true);
    unmount();
    expect(signals[1]?.aborted).toBe(true);
    await tick(3 * POLL_MS);
    expect(calls).toHaveLength(2);
  });
});
