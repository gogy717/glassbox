import { afterEach, describe, expect, it } from 'vitest';
import { createDemoSideSnapshots, createDemoSnapshot } from '../core/fixtures/demo.js';
import type { SessionSnapshot } from '../core/model.js';
import { totalTokens } from '../core/usage.js';
import type { WeekSession, WeekWindow } from '../shared/week.js';
import {
  HOUR_MS,
  hourStart,
  type SessionBuckets,
  sessionBuckets,
  sessionBucketsPausing,
  sliceSession,
  weekStart,
  weekWindow,
} from './week-buckets.js';
import { createDemoWeek } from './week-demo.js';

/** Every hour a session's buckets hold: a window that takes all of it. */
const everything = (b: SessionBuckets): WeekWindow => {
  const hs = [...b.hours.keys()].sort((x, y) => x - y);
  const first = hs[0] ?? 0;
  const last = hs.at(-1) ?? 0;
  const hourStarts: number[] = [];
  for (let h = first; h <= last; h += HOUR_MS) hourStarts.push(h);
  return { kind: '7d', hourStarts, now: last + HOUR_MS };
};

/** The figures that add up across windows (sub-agents overlap, so they do not). */
const additive = (s: WeekSession | null) => {
  const f = s?.inWindow;
  return {
    activeMs: f?.activeMs ?? 0,
    agentMs: f?.agentMs ?? 0,
    requests: f?.requests ?? 0,
    toolCalls: f?.toolCalls ?? 0,
    failures: f?.failures ?? 0,
    tokens: f ? totalTokens(f.usage) : 0,
    thinking: f?.usage.thinking ?? 0,
    cats: Object.values(f?.toolCats ?? {}).reduce((a, b) => a + b, 0),
  };
};
const plus = (a: ReturnType<typeof additive>, b: ReturnType<typeof additive>) =>
  Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v + b[k as keyof typeof b]]));

describe('windows', () => {
  const tz = process.env.TZ;
  afterEach(() => {
    // Assigning undefined would set the zone named "undefined" (UTC) for every later test.
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  // Sat 21 Nov: no common time zone changes its clocks that week (the tests hold anywhere).
  it('starts this week on local Monday 00:00 and runs to next Monday', () => {
    const now = new Date(2026, 10, 21, 20, 41).getTime();
    const w = weekWindow('week', now);
    expect(new Date(w.hourStarts[0] as number)).toEqual(new Date(2026, 10, 16, 0, 0));
    expect(w.hourStarts).toHaveLength(168);
    expect(w.now).toBe(now);
  });

  it('takes the last 7 days as 168 hours ending with the current one (R20)', () => {
    const now = new Date(2026, 10, 21, 20, 41).getTime();
    const w = weekWindow('7d', now);
    expect(w.hourStarts).toHaveLength(168);
    expect(w.hourStarts.at(-1)).toBe(new Date(2026, 10, 21, 20, 0).getTime());
    expect(w.hourStarts[0]).toBe(new Date(2026, 10, 14, 21, 0).getTime());
  });

  it('has 167 hours in the week the clocks go forward, on local whole hours', () => {
    process.env.TZ = 'Australia/Sydney'; // DST from Sun 4 Oct 2026, 02:00 → 03:00
    const w = weekWindow('week', new Date('2026-10-02T12:00:00+10:00').getTime());
    expect(w.hourStarts).toHaveLength(167);
    expect(w.hourStarts.every((h) => new Date(h).getMinutes() === 0)).toBe(true);
  });

  it('takes 168 hours for the last 7 days even across a half-hour change of the clocks (N3)', () => {
    process.env.TZ = 'Australia/Lord_Howe'; // DST from Sun 4 Oct 2026, 02:00 → 02:30
    const now = new Date('2026-10-06T12:30:00+11:00').getTime();
    const w = weekWindow('7d', now);
    expect(w.hourStarts).toHaveLength(168);
    expect(
      new Set(w.hourStarts.map((h, i) => h - (w.hourStarts[0] as number) - i * HOUR_MS)),
    ).toEqual(new Set([0]));
    expect(w.hourStarts.at(-1)).toBe(hourStart(now));
    // A session before the change, its buckets on local hours half an hour off the window's
    // hours of the clock: every one still lands in an hour of the window.
    const at = Date.parse('2026-10-03T12:30:00+10:30');
    const snap = createDemoSnapshot(new Date(at));
    const b = sessionBuckets(snap, at);
    expect([...b.hours.keys()].every((k) => !w.hourStarts.includes(k))).toBe(true);
    const s = sliceSession(b, w);
    expect(s?.hours.reduce((a, h) => a + h, 0)).toBe(s?.inWindow.agentMs);
    expect(s?.inWindow.agentMs).toBe(
      [...b.hours.values()].reduce((a, bucket) => a + bucket.agentMs, 0),
    );
  });

  it('keeps hours on the local hour where the offset is half an hour', () => {
    process.env.TZ = 'Asia/Kolkata';
    const t = Date.parse('2026-10-22T10:10:00Z'); // 15:40 local
    expect(new Date(hourStart(t)).toISOString()).toBe('2026-10-22T09:30:00.000Z');
    expect(new Date(weekStart(t)).toISOString()).toBe('2026-10-18T18:30:00.000Z');
  });
});

describe('a session as hourly buckets', () => {
  it('counts a session crossing Monday 00:00 on both sides, adding up to all of it (W1)', () => {
    const monday = new Date(2026, 10, 23, 0, 0).getTime();
    const now = monday + 40_000;
    // The demo's 40 minutes end now: its last turn and call run across midnight.
    const snap = createDemoSnapshot(new Date(now));
    const b = sessionBuckets(snap, now);
    const all = sliceSession(b, everything(b));
    const before = sliceSession(b, weekWindow('week', monday - 1));
    const after = sliceSession(b, weekWindow('week', now));
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(plus(additive(before), additive(after))).toEqual(additive(all));
    expect(additive(all).requests).toBe(snap.requests.length);
    // The main agent's turns, cut at midnight: what falls after it is this week's.
    const cut = snap.turns
      .filter((t) => t.agentId === 'main')
      .reduce((n, t) => {
        const end = t.endedAt ? Date.parse(t.endedAt) : now;
        return n + Math.max(0, end - Math.max(Date.parse(t.startedAt), monday));
      }, 0);
    expect(after?.inWindow.activeMs).toBe(cut);
    expect(after?.hours[0]).toBeGreaterThan(0);
    expect(after?.hours.slice(1).every((h) => h === 0)).toBe(true);
    // A sub-agent alive across midnight is alive in both weeks.
    expect(all?.inWindow.subAgents).toBe(snap.agents.length - 1);
    expect(
      (before?.inWindow.subAgents ?? 0) + (after?.inWindow.subAgents ?? 0),
    ).toBeGreaterThanOrEqual(all?.inWindow.subAgents ?? 0);
  });

  it('splits a turn at hour boundaries, and its hours hold its agent time', () => {
    const now = new Date(2026, 9, 22, 12, 30).getTime();
    const [side] = createDemoSideSnapshots(new Date(now));
    if (!side) throw new Error('no side session');
    const b = sessionBuckets(side, now);
    const s = sliceSession(b, everything(b));
    expect(s?.hours.reduce((a, h) => a + h, 0)).toBe(s?.inWindow.agentMs);
    const turn = side.turns[0];
    expect(s?.inWindow.activeMs).toBe(
      Date.parse(turn?.endedAt ?? '') - Date.parse(turn?.startedAt ?? ''),
    );
  });

  it('leaves out a session with nothing in the window', () => {
    const now = new Date(2026, 9, 22, 12, 30).getTime();
    const b = sessionBuckets(createDemoSnapshot(new Date(now)), now);
    expect(sliceSession(b, weekWindow('week', now + 14 * 24 * HOUR_MS))).toBeNull();
  });

  it('buckets the same with pauses between steps, pausing in a large session (M6)', async () => {
    const now = new Date(2026, 10, 21, 20, 41).getTime();
    // A week of sessions as one agent's: thousands of calls and tools, no sub-agent to pause at.
    const all = createDemoWeek(now);
    const main = (all[0] as SessionSnapshot).agents.filter((a) => a.id === 'main');
    const big: SessionSnapshot = {
      ...(all[0] as SessionSnapshot),
      agents: main,
      turns: all.flatMap((x) => x.turns).map((t) => ({ ...t, agentId: 'main' })),
      requests: all.flatMap((x) => x.requests).map((q) => ({ ...q, agentId: 'main' })),
      toolCalls: all.flatMap((x) => x.toolCalls).map((t) => ({ ...t, agentId: 'main' })),
    };
    expect(big.requests.length + big.toolCalls.length).toBeGreaterThan(6000);
    let pauses = 0;
    const paused = await sessionBucketsPausing(big, now, async () => {
      pauses++;
    });
    // Every 2,000 steps through some 13,000 (turns, calls, tools).
    expect(pauses).toBeGreaterThanOrEqual(5);
    expect(paused).toEqual(sessionBuckets(big, now));
  });

  it('knows a session reports usage though its only call in the window is still in flight (M5)', () => {
    const now = new Date(2026, 10, 21, 20, 41).getTime();
    const [side] = createDemoSideSnapshots(new Date(now - 3 * HOUR_MS));
    if (!side) throw new Error('no side session');
    const last = side.requests.at(-1);
    if (!last) throw new Error('no request');
    Object.assign(last, {
      status: 'in-flight',
      usage: null,
      startedAt: new Date(now - 60_000).toISOString(),
      firstBlockAt: null,
      endedAt: null,
    });
    const b = sessionBuckets(side, now);
    const thisHour = { kind: '7d' as const, hourStarts: [hourStart(now)], now };
    const s = sliceSession(b, thisHour);
    expect(s?.inWindow.requests).toBe(1);
    expect(s && totalTokens(s.inWindow.usage)).toBe(0);
    expect(s?.reportsUsage).toBe(true);
    for (const q of side.requests) q.usage = null;
    expect(sessionBuckets(side, now).reportsUsage).toBe(false);
  });

  it('counts every agent’s own turns as agent time, the main agent’s as session time (DR7)', () => {
    const now = new Date(2026, 10, 21, 20, 41).getTime();
    const snap = createDemoSnapshot(new Date(now));
    const b = sessionBuckets(snap, now);
    const s = sliceSession(b, everything(b));
    const turns = (agentId?: string) =>
      snap.turns
        .filter((t) => agentId === undefined || t.agentId === agentId)
        .reduce(
          (n, t) => n + ((t.endedAt ? Date.parse(t.endedAt) : now) - Date.parse(t.startedAt)),
          0,
        );
    expect(s?.inWindow.activeMs).toBe(turns('main'));
    expect(s?.inWindow.agentMs).toBe(turns());
    expect(s?.inWindow.agentMs).toBeGreaterThan(s?.inWindow.activeMs ?? 0);
  });

  it('counts no time after the moment it is bucketed as of, though the snapshot runs on', () => {
    const now = new Date(2026, 10, 21, 20, 41).getTime();
    const snap = createDemoSnapshot(new Date(now));
    // In the middle of a finished turn of the main agent's, before the sub-agents start.
    const cut = now - 34.5 * 60_000;
    expect(
      snap.turns.some(
        (t) => t.endedAt && Date.parse(t.startedAt) < cut && Date.parse(t.endedAt) > cut,
      ),
    ).toBe(true);
    const b = sessionBuckets(snap, cut);
    expect(Math.max(...[...b.hours].filter(([, x]) => x.agentMs > 0).map(([h]) => h))).toBe(
      hourStart(cut),
    );
    const s = sliceSession(b, everything(b));
    const upTo = (agentId?: string) =>
      snap.turns
        .filter((t) => agentId === undefined || t.agentId === agentId)
        .reduce((n, t) => {
          const start = Date.parse(t.startedAt);
          const end = Math.min(t.endedAt ? Date.parse(t.endedAt) : now, cut);
          return n + Math.max(0, end - start);
        }, 0);
    expect(s?.inWindow.agentMs).toBe(upTo());
    expect(s?.inWindow.activeMs).toBe(upTo('main'));
  });
});
