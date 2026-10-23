import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThrottled } from './useThrottled';

describe('useThrottled', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes the first value at once, then at most one update per interval with the latest value', () => {
    const { result, rerender } = renderHook(({ v }) => useThrottled(v, 1000), {
      initialProps: { v: 1 },
    });
    expect(result.current).toBe(1);
    rerender({ v: 2 });
    rerender({ v: 3 });
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(999));
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(3);
  });

  it('settles on the last value after a burst', () => {
    const { result, rerender } = renderHook(({ v }) => useThrottled(v, 500), {
      initialProps: { v: 'a' },
    });
    act(() => vi.advanceTimersByTime(600));
    rerender({ v: 'b' });
    expect(result.current).toBe('b');
    rerender({ v: 'c' });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe('c');
  });
});
