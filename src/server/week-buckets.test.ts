import { afterEach, describe, expect, it } from 'vitest';
import { createDemoSideSnapshots, createDemoSnapshot } from '../core/fixtures/demo.js';
import type { SessionSnapshot } from '../core/model.js';
import { emptyUsage, totalTokens } from '../core/usage.js';
import { fileOpsOf } from '../shared/crossing.js';
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
    opusTokens: totalTokens(f?.usageByModel['claude-opus-5-5'] ?? emptyUsage()),
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

  it('puts a bucket that runs into the first hour of the last 7 days in that hour (Lord Howe)', () => {
    process.env.TZ = 'Australia/Lord_Howe';
    const now = new Date('2026-10-06T12:30:00+11:00').getTime();
    const w = weekWindow('7d', now);
    const first = w.hourStarts[0] as number;
    // Its local hour, 12:00–13:00 at +10:30, starts half an hour before the window's first.
    const at = Date.parse('2026-09-29T12:55:00+10:30');
    const b = sessionBuckets(createDemoSnapshot(new Date(at)), at);
    expect([...b.hours.keys()]).toEqual([first - HOUR_MS / 2]);
    const all = [...b.hours.values()].reduce((n, x) => n + x.agentMs, 0);
    expect(all).toBeGreaterThan(0);
    const s = sliceSession(b, w);
    expect(s?.hours[0]).toBe(all);
    expect(s?.inWindow.agentMs).toBe(all);
    // An hour earlier it ends before the window: left out.
    expect(
      sliceSession(sessionBuckets(createDemoSnapshot(new Date(at - HOUR_MS)), at - HOUR_MS), w),
    ).toBeNull();
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
    expect(additive(all).opusTokens).toBe(additive(all).tokens);
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

  // The Claude Code parser ends a local command's turn (/model, no call) at its own start.
  it('counts no time for a turn that ended at its own start: a local command before the prompt', () => {
    const now = new Date(2026, 10, 21, 20, 41).getTime();
    const snap = createDemoSnapshot(new Date(now));
    const base = sessionBuckets(snap, now);
    // An hour before the demo's first prompt, in an hour of its own.
    const started = new Date(now - 60 * 60_000).toISOString();
    snap.turns.unshift({
      id: 'turn_m0',
      agentId: 'main',
      index: 0,
      origin: 'human',
      prompt: '/model',
      startedAt: started,
      endedAt: started,
      status: 'complete',
      requestIds: [],
    });
    const b = sessionBuckets(snap, now);
    expect(b.hours.has(hourStart(now - 60 * 60_000))).toBe(false);
    expect(additive(sliceSession(b, everything(b)))).toEqual(
      additive(sliceSession(base, everything(base))),
    );
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

  it('adds two buckets that fall in one hour of the window, losing neither', () => {
    const h = new Date(2026, 10, 21, 10).getTime();
    const bucket = (agentMs: number) => ({
      activeMs: agentMs,
      agentMs,
      requests: 1,
      toolCalls: 0,
      toolCats: {},
      failures: 0,
      usage: { ...emptyUsage(), output: agentMs },
      usageByModel: { m: { ...emptyUsage(), output: agentMs } },
      files: new Map(),
    });
    const b: SessionBuckets = {
      id: 's',
      updatedAt: new Date(h).toISOString(),
      agent: 'claude-code',
      project: 'p',
      cwd: null,
      title: null,
      hours: new Map([
        [h, bucket(10 * 60_000)],
        [h + 30 * 60_000, bucket(5 * 60_000)],
      ]),
      subAgents: [],
      reportsUsage: false,
    };
    const s = sliceSession(b, { kind: '7d', hourStarts: [h, h + HOUR_MS], now: h });
    expect(s?.hours).toEqual([15 * 60_000, 0]);
    expect(s?.inWindow.agentMs).toBe(15 * 60_000);
    expect(s?.inWindow.usageByModel.m?.output).toBe(15 * 60_000);
  });

  // Proposal 6: the client prices a week by model, so usage keeps the model of each call.
  it('keeps the files its calls changed, as the session’s own changes say, files last', () => {
    const now = new Date(2026, 9, 22, 12, 30).getTime();
    const snap = createDemoSnapshot(new Date(now));
    const b = sessionBuckets(snap, now);
    const all = sliceSession(b, everything(b));
    // The main agent and its descendants, as the week counts their calls.
    const ids = new Set(['main']);
    for (let grew = true; grew; ) {
      grew = false;
      for (const a of snap.agents)
        if (a.parentId !== null && ids.has(a.parentId) && !ids.has(a.id))
          grew = ids.add(a.id).size > 0;
    }
    const files = fileOpsOf(snap.toolCalls, snap.session.cwd, ids, 0);
    expect(files?.paths.length).toBeGreaterThan(2);
    expect(all?.inWindow.files).toEqual(files);
    expect(Object.keys(all?.inWindow ?? {}).at(-1)).toBe('files');
    // A session that changed no file says nothing of files.
    const [side] = createDemoSideSnapshots(new Date(now));
    if (!side) throw new Error('no side session');
    const quiet = { ...side, toolCalls: side.toolCalls.filter((t) => !/Edit|Write/.test(t.name)) };
    const sq = sliceSession(sessionBuckets(quiet, now), everything(sessionBuckets(quiet, now)));
    expect(sq?.inWindow).not.toHaveProperty('files');
  });

  it('counts a change in the window its call started in, as it counts the call', () => {
    const monday = new Date(2026, 10, 23, 0, 0).getTime();
    const now = monday + 40_000;
    const snap = createDemoSnapshot(new Date(now));
    // One edit of the demo's fix lands after midnight; the rest of its file work before.
    const late = snap.toolCalls.find((t) => t.id === 'tu_m2e');
    if (!late) throw new Error('fixture');
    late.startedAt = new Date(monday + 5_000).toISOString();
    late.endedAt = new Date(monday + 6_000).toISOString();
    const b = sessionBuckets(snap, now);
    const store = (s: WeekSession | null) =>
      s?.inWindow.files?.paths.find((p) => p.path.endsWith('/src/server/store.ts'));
    const before = store(sliceSession(b, weekWindow('week', monday - 1)));
    const after = store(sliceSession(b, weekWindow('week', now)));
    expect(after?.edited).toBe(1);
    expect(after?.marks.map((m) => m[0])).toEqual([monday + 6_000]);
    expect((before?.edited ?? 0) + (after?.edited ?? 0)).toBe(
      store(sliceSession(b, everything(b)))?.edited,
    );
  });

  it('keeps usage by the model of each call, adding up to the usage', () => {
    const now = new Date(2026, 9, 22, 12, 30).getTime();
    const snap = createDemoSnapshot(new Date(now));
    const sub = snap.requests.filter((r) => r.agentId !== 'main' && r.usage);
    for (const r of sub) r.model = 'claude-haiku-5-5';
    const nameless = snap.requests.find((r) => r.agentId === 'main' && r.usage);
    if (!nameless || sub.length === 0) throw new Error('fixture');
    nameless.model = null;
    const s = sliceSession(sessionBuckets(snap, now), everything(sessionBuckets(snap, now)));
    const byModel = s?.inWindow.usageByModel ?? {};
    expect(Object.keys(byModel).sort()).toEqual(['', 'claude-haiku-5-5', 'claude-opus-5-5']);
    const tokensOf = (model: string | null) =>
      snap.requests
        .filter((r) => r.model === model && r.usage)
        .reduce((n, r) => n + totalTokens(r.usage ?? emptyUsage()), 0);
    expect(totalTokens(byModel['claude-haiku-5-5'] ?? emptyUsage())).toBe(
      tokensOf('claude-haiku-5-5'),
    );
    expect(totalTokens(byModel[''] ?? emptyUsage())).toBe(tokensOf(null));
    const sum = Object.values(byModel).reduce((n, u) => n + totalTokens(u), 0);
    expect(sum).toBe(totalTokens(s?.inWindow.usage ?? emptyUsage()));
  });
});
