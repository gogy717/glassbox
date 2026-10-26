import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSearchPrefs, useSearchPrefs } from './search-prefs';

describe('useSearchPrefs', () => {
  afterEach(() => {
    localStorage.clear();
    resetSearchPrefs();
    vi.restoreAllMocks();
  });

  it('searches titles until told otherwise, and remembers the choice', () => {
    const first = renderHook(() => useSearchPrefs());
    expect(first.result.current[0]).toEqual({ scope: 'titles' });
    act(() => first.result.current[1]({ scope: 'everything' }));
    expect(first.result.current[0]).toEqual({ scope: 'everything' });
    expect(JSON.parse(localStorage.getItem('glassbox.search') ?? 'null')).toEqual({
      scope: 'everything',
    });
    // A new page reads it back.
    resetSearchPrefs();
    expect(renderHook(() => useSearchPrefs()).result.current[0]).toEqual({ scope: 'everything' });
  });

  it('reads anything else it finds as titles', () => {
    localStorage.setItem('glassbox.search', '{"scope":"all"}');
    expect(renderHook(() => useSearchPrefs()).result.current[0]).toEqual({ scope: 'titles' });
    resetSearchPrefs();
    localStorage.setItem('glassbox.search', 'not json');
    expect(renderHook(() => useSearchPrefs()).result.current[0]).toEqual({ scope: 'titles' });
  });

  it('still switches where storage refuses to keep it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { result } = renderHook(() => useSearchPrefs());
    act(() => result.current[1]({ scope: 'everything' }));
    expect(result.current[0]).toEqual({ scope: 'everything' });
  });
});
