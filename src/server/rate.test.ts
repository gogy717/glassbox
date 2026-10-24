import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '../core/model.js';
import { emptyUsage } from '../core/usage.js';
import { hourTotal, MINUTE_MS, ratePerMinute, rateSeries } from '../shared/rate.js';
import { RateTracker } from './rate.js';

const T0 = Date.UTC(2026, 9, 24, 10, 0, 0);
const usage = (o: Partial<TokenUsage>): TokenUsage => ({ ...emptyUsage(), ...o });

function tracker(start = T0) {
  let now = start;
  const t = new RateTracker(() => now);
  return {
    t,
    at: (ms: number) => {
      now = ms;
    },
    later: (ms: number) => {
      now += ms;
    },
  };
}

describe('RateTracker', () => {
  it('takes the first sighting of a session as a baseline, not a spike', () => {
    const { t } = tracker();
    expect(t.observe('s1', 'claude-code', usage({ cacheRead: 5_000_000, output: 90_000 }))).toBe(
      false,
    );
    expect(hourTotal(t.snapshot())).toBe(0);
  });

  it('counts each later observation’s growth, per token kind, in the minute it was seen', () => {
    const { t, later } = tracker();
    t.observe('s1', 'claude-code', usage({ input: 10, cacheRead: 1000, output: 50 }));
    later(20_000);
    expect(
      t.observe(
        's1',
        'claude-code',
        usage({ input: 12, cacheRead: 1800, cacheWrite: 40, output: 90 }),
      ),
    ).toBe(true);
    const snap = t.snapshot();
    const cc = snap.agents['claude-code'];
    expect([
      cc?.input.at(-1),
      cc?.cacheRead.at(-1),
      cc?.cacheWrite.at(-1),
      cc?.output.at(-1),
    ]).toEqual([2, 800, 40, 40]);
    expect(rateSeries(snap).at(-1)).toBe(882);
    // Nothing new: nothing counted.
    expect(
      t.observe(
        's1',
        'claude-code',
        usage({ input: 12, cacheRead: 1800, cacheWrite: 40, output: 90 }),
      ),
    ).toBe(false);
  });

  it('never counts a shrinking total: a rebuilt session starts a new baseline', () => {
    const { t } = tracker();
    t.observe('s1', 'codex', usage({ cacheRead: 5000, output: 100 }));
    expect(t.observe('s1', 'codex', usage({ cacheRead: 4000, output: 120 }))).toBe(false);
    expect(hourTotal(t.snapshot())).toBe(0);
    t.observe('s1', 'codex', usage({ cacheRead: 4500, output: 130 }));
    expect(hourTotal(t.snapshot())).toBe(510);
  });

  it('ignores a session not parsed yet (no usage), and forgets one no longer watched', () => {
    const { t } = tracker();
    expect(t.observe('s1', 'grok', null)).toBe(false);
    t.observe('s1', 'grok', usage({ output: 100 }));
    t.forget('s1');
    // Reopened later with everything it did meanwhile: a baseline again, not a spike.
    expect(t.observe('s1', 'grok', usage({ output: 90_100 }))).toBe(false);
    expect(hourTotal(t.snapshot())).toBe(0);
  });

  it('counts a transcript parsed late in the minute it was read (the documented caveat)', () => {
    const { t, later } = tracker();
    t.observe('s1', 'claude-code', usage({ cacheRead: 1000 }));
    later(MINUTE_MS);
    // A sub-agent file classified after the session opened brings its whole history at once.
    t.observe('s1', 'claude-code', usage({ cacheRead: 401_000 }));
    expect(rateSeries(t.snapshot()).at(-1)).toBe(400_000);
  });

  it('sums sessions per agent kind and keeps the kinds apart', () => {
    const { t } = tracker();
    for (const [id, agent] of [
      ['a', 'claude-code'],
      ['b', 'claude-code'],
      ['c', 'codex'],
    ] as const) {
      t.observe(id, agent, usage({}));
      t.observe(id, agent, usage({ output: 100 }));
    }
    const snap = t.snapshot();
    expect(Object.keys(snap.agents).sort()).toEqual(['claude-code', 'codex']);
    expect(rateSeries(snap, { agent: 'claude-code' }).at(-1)).toBe(200);
    expect(rateSeries(snap, { agent: 'codex' }).at(-1)).toBe(100);
    expect(rateSeries(snap, { agent: 'grok' }).at(-1)).toBe(0);
  });

  it('rolls minutes over and keeps exactly the last hour', () => {
    const { t, at } = tracker();
    t.observe('s1', 'claude-code', usage({}));
    let total = 0;
    for (let m = 0; m < 70; m++) {
      at(T0 + m * MINUTE_MS + 30_000);
      total += 10;
      t.observe('s1', 'claude-code', usage({ output: total }));
    }
    const snap = t.snapshot();
    expect(snap.minute).toBe(new Date(T0 + 69 * MINUTE_MS).toISOString());
    const series = rateSeries(snap);
    expect(series).toHaveLength(60);
    expect(series.every((n) => n === 10)).toBe(true);
    expect(hourTotal(snap)).toBe(600);
    // An idle stretch empties the window as the minutes pass.
    at(T0 + 200 * MINUTE_MS);
    expect(hourTotal(t.snapshot())).toBe(0);
    expect(ratePerMinute(t.snapshot())).toBe(0);
  });

  it('says since when it has counted, so the minutes before are unknown, not idle', () => {
    const { t, later } = tracker();
    later(90_000);
    const snap = t.snapshot();
    expect(snap.since).toBe(new Date(T0).toISOString());
    expect(snap.at).toBe(new Date(T0 + 90_000).toISOString());
  });
});
