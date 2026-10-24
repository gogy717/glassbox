import { afterEach, describe, expect, it } from 'vitest';
import { createDemoSideSnapshots, createDemoSnapshot } from '../core/fixtures/demo.js';
import { totalTokens } from '../core/usage.js';
import type { WeekSession, WeekWindow } from '../shared/week.js';
import {
  HOUR_MS,
  hourStart,
  type SessionBuckets,
  sessionBuckets,
  sliceSession,
  weekStart,
  weekWindow,
} from './week-buckets.js';

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
    process.env.TZ = tz;
  });

  it('starts this week on local Monday 00:00 and runs to next Monday', () => {
    const now = new Date(2026, 9, 24, 20, 41).getTime(); // Sat 24 Oct
    const w = weekWindow('week', now);
    expect(new Date(w.hourStarts[0] as number)).toEqual(new Date(2026, 9, 19, 0, 0));
    expect(w.hourStarts).toHaveLength(168);
    expect(w.now).toBe(now);
  });

  it('takes the last 7 days as 168 hours ending with the current one (R20)', () => {
    const now = new Date(2026, 9, 24, 20, 41).getTime();
    const w = weekWindow('7d', now);
    expect(w.hourStarts).toHaveLength(168);
    expect(w.hourStarts.at(-1)).toBe(new Date(2026, 9, 24, 20, 0).getTime());
    expect(w.hourStarts[0]).toBe(new Date(2026, 9, 17, 21, 0).getTime());
  });

  it('has 167 hours in the week the clocks go forward, on local whole hours', () => {
    process.env.TZ = 'Australia/Sydney'; // DST from Sun 4 Oct 2026, 02:00 → 03:00
    const w = weekWindow('week', new Date('2026-10-02T12:00:00+10:00').getTime());
    expect(w.hourStarts).toHaveLength(167);
    expect(w.hourStarts.every((h) => new Date(h).getMinutes() === 0)).toBe(true);
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
    const monday = new Date(2026, 9, 26, 0, 0).getTime();
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
});
