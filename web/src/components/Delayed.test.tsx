import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Delayed, WAIT_MS } from './Delayed';

// I3b parked item: a local load is usually done within a frame or two, and a "Loading…" that
// flashes for that long reads as a glitch. A wait says so only once it has lasted 200 ms.
describe('Delayed', () => {
  afterEach(() => vi.useRealTimers());

  it('shows nothing for the first 200 ms, then its children', () => {
    vi.useFakeTimers();
    render(
      <Delayed>
        <p>Loading…</p>
      </Delayed>,
    );
    expect(WAIT_MS).toBe(200);
    act(() => vi.advanceTimersByTime(WAIT_MS - 1));
    expect(screen.queryByText('Loading…')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('never shows a wait that ended sooner', () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <Delayed>
        <p>Loading…</p>
      </Delayed>,
    );
    act(() => vi.advanceTimersByTime(100));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
