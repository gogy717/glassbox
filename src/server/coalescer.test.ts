import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Coalescer } from './coalescer.js';

let fired: number[];
/** The clock the coalescer reads; `lag` makes it run behind the timers, as libuv's can. */
let lag: number;
const now = () => Date.now() - lag;

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  fired = [];
  lag = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

const make = (gapMs = 100) => new Coalescer(gapMs, () => fired.push(now()), now);

describe('Coalescer', () => {
  it('fires the first request on the next turn, folding a synchronous burst into it', async () => {
    const c = make();
    c.request();
    c.request();
    c.request();
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fired).toEqual([1_000_000]);
  });

  it('folds requests inside the gap into one trailing fire, a full gap after the last', async () => {
    const c = make();
    c.request();
    await vi.advanceTimersByTimeAsync(10);
    expect(fired).toEqual([1_000_000]);
    c.request();
    c.request();
    await vi.advanceTimersByTimeAsync(40);
    c.request();
    expect(fired).toEqual([1_000_000]);
    await vi.advanceTimersByTimeAsync(50);
    expect(fired).toEqual([1_000_000, 1_000_100]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).toHaveLength(2);
  });

  it('fires at once again after a quiet gap', async () => {
    const c = make();
    c.request();
    await vi.advanceTimersByTimeAsync(250);
    c.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(fired).toEqual([1_000_000, 1_000_250]);
  });

  it('never fires early, even when its timer does', async () => {
    const c = make();
    c.request();
    await vi.advanceTimersByTimeAsync(0);
    c.request(); // trailing fire due at +100
    lag = 7; // the timer wakes when the clock still reads +93
    await vi.advanceTimersByTimeAsync(100);
    expect(fired).toEqual([1_000_000]);
    await vi.advanceTimersByTimeAsync(7);
    expect(fired).toEqual([1_000_000, 1_000_100]);
  });

  it('drops a pending fire on cancel', async () => {
    const c = make();
    c.request();
    await vi.advanceTimersByTimeAsync(0);
    c.request();
    c.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(fired).toEqual([1_000_000]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
