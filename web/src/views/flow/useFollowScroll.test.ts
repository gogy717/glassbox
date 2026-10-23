import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFollowScroll } from './useFollowScroll';

class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  targets: Element[] = [];
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.all.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.targets = [];
  }
}

const resize = (el: Element) => {
  for (const ro of FakeResizeObserver.all)
    if (ro.targets.includes(el)) ro.callback([], ro as unknown as ResizeObserver);
};

function scroller(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 5_000 });
  el.scrollTop = 1_000;
  return el;
}

describe('useFollowScroll', () => {
  beforeEach(() => {
    FakeResizeObserver.all = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a followed list at the bottom when its viewport changes size', () => {
    const ref = { current: scroller() };
    renderHook(() => useFollowScroll(ref, true, vi.fn()));
    ref.current.scrollTop = 1_000;
    resize(ref.current);
    expect(ref.current.scrollTop).toBe(5_000);
  });

  it('leaves the reader’s place alone when not following', () => {
    const ref = { current: scroller() };
    renderHook(() => useFollowScroll(ref, false, vi.fn()));
    resize(ref.current);
    expect(ref.current.scrollTop).toBe(1_000);
  });
});
