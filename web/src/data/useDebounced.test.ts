import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebounced } from './useDebounced';

describe('useDebounced', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes the first value at once, then each value once it has held for the interval', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 150), {
      initialProps: { v: 'l' },
    });
    expect(result.current).toBe('l');
    rerender({ v: 'lo' });
    act(() => vi.advanceTimersByTime(100));
    rerender({ v: 'log' });
    // Typing on restarts the wait: 100 ms after "lo" and 149 after "log", neither has held.
    act(() => vi.advanceTimersByTime(149));
    expect(result.current).toBe('l');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('log');
  });

  it('settles on the value it was left with, not one passed on the way', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 150), {
      initialProps: { v: 1 },
    });
    rerender({ v: 2 });
    rerender({ v: 1 });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(1);
  });
});
