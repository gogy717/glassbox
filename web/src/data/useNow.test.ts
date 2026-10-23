import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNow } from './useNow';

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T10:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('returns the current time and advances once per interval', () => {
    const { result } = renderHook(() => useNow());
    const start = Date.parse('2026-10-23T10:00:00.000Z');
    expect(result.current).toBe(start);
    act(() => vi.advanceTimersByTime(999));
    expect(result.current).toBe(start);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(start + 1000);
  });

  it('stops ticking after unmount', () => {
    const { unmount } = renderHook(() => useNow(500));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
