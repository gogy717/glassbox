import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoQuotas, DEMO_SESSION_ID } from '../core/fixtures/demo.js';
import { checkSnapshot } from '../core/invariants.js';
import type { SessionPatch, SessionSnapshot, SessionSummary } from '../core/model.js';
import { hourTotal, ratePerMinute, rateSeries, type TokenRate } from '../shared/rate.js';
import { applyPatch } from './__tests__/apply-patch.js';
import { DemoStore } from './demo-store.js';

let store: DemoStore;

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-10-23T02:00:00.000Z') });
  store = new DemoStore();
  await store.start();
});

afterEach(async () => {
  await store.stop();
  vi.useRealTimers();
});

describe('DemoStore', () => {
  it('serves the demo session list with the busy demo session first', () => {
    const list = store.listSessions();
    expect(list.map((s) => s.id)[0]).toBe(DEMO_SESSION_ID);
    expect(list[0]?.live).toBe('busy');
    expect(list).toHaveLength(3);
  });

  // The sidebar offers every listed session; each must open (audit #25).
  it('opens every session it lists, with its details and results', async () => {
    for (const { id } of store.listSessions()) {
      const snap = (await store.getSnapshot(id)) as SessionSnapshot;
      expect(snap?.session.id).toBe(id);
      expect(checkSnapshot(snap)).toEqual([]);
      const req = snap.requests[0];
      if (!req) throw new Error(`no requests in ${id}`);
      expect((await store.getRequestDetail(id, req.id))?.requestId).toBe(req.id);
      const tool = snap.toolCalls.find((t) => t.hasFullResult);
      if (tool) expect((await store.getToolResult(id, tool.id)).found).toBe(true);
    }
  });

  it('serves the snapshot, details and results of the demo session only', async () => {
    const snap = (await store.getSnapshot(DEMO_SESSION_ID)) as SessionSnapshot;
    expect(checkSnapshot(snap)).toEqual([]);
    expect(await store.getSnapshot('claude-code:nope')).toBeNull();

    expect((await store.getRequestDetail(DEMO_SESSION_ID, 'req_m1'))?.completeness).toBe('full');
    expect(await store.getRequestDetail(DEMO_SESSION_ID, 'nope')).toBeNull();
    expect(await store.getRequestDetail('claude-code:nope', 'req_m1')).toBeNull();

    expect(await store.getToolResult(DEMO_SESSION_ID, 'tu_m1a')).toEqual({
      found: true,
      result: 'src/server/store.ts:41:export function sortSessions(',
    });
    expect(await store.getToolResult(DEMO_SESSION_ID, 'nope')).toEqual({
      found: false,
      result: undefined,
    });
  });

  it('emits a patch every 2 s', async () => {
    const patches: SessionPatch[] = [];
    store.onPatch(DEMO_SESSION_ID, (p) => patches.push(p));
    await vi.advanceTimersByTimeAsync(1999);
    expect(patches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.session.updatedAt).toBe('2026-10-23T02:00:02.000Z');
    await vi.advanceTimersByTimeAsync(4000);
    expect(patches).toHaveLength(3);
  });

  it('completes the running tool and the in-flight request, then starts new work', async () => {
    const before = (await store.getSnapshot(DEMO_SESSION_ID)) as SessionSnapshot;
    const running = before.toolCalls.filter((t) => t.status === 'running').map((t) => t.id);
    const inFlight = before.requests.filter((r) => r.status === 'in-flight').map((r) => r.id);
    expect(running.length).toBeGreaterThan(0);
    expect(inFlight.length).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(60_000);

    const after = (await store.getSnapshot(DEMO_SESSION_ID)) as SessionSnapshot;
    for (const id of running)
      expect(after.toolCalls.find((t) => t.id === id)?.status).toBe('complete');
    const mainInFlight = inFlight.filter(
      (id) => before.requests.find((r) => r.id === id)?.agentId === 'main',
    );
    for (const id of mainInFlight) {
      const r = after.requests.find((x) => x.id === id);
      expect(r?.status).toBe('complete');
      expect(r?.usage?.output).toBeGreaterThan(0);
    }
    expect(after.requests.length).toBeGreaterThan(before.requests.length);
    expect(after.turns.length).toBeGreaterThan(before.turns.length);
    expect(checkSnapshot(after)).toEqual([]);
  });

  it('keeps patches consistent with the snapshot a reconnecting client would get', async () => {
    let client = (await store.getSnapshot(DEMO_SESSION_ID)) as SessionSnapshot;
    store.onPatch(DEMO_SESSION_ID, (p) => {
      client = applyPatch(client, p);
    });

    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      expect(client).toEqual(await store.getSnapshot(DEMO_SESSION_ID));
    }
  });

  it('pushes the updated session to the list', async () => {
    const lists: SessionSummary[][] = [];
    store.onSessions((l) => lists.push(l));
    await vi.advanceTimersByTimeAsync(2000);
    expect(lists.at(-1)?.[0]?.updatedAt).toBe('2026-10-23T02:00:02.000Z');
    expect(store.listSessions()[0]?.updatedAt).toBe('2026-10-23T02:00:02.000Z');
  });

  it('lists what the demo session is doing as it moves on', async () => {
    const seen = new Map<string, string | null>();
    store.onSessions((l) => {
      const a = l.find((x) => x.id === DEMO_SESSION_ID)?.activity;
      if (a) seen.set(a.kind, a.target ?? seen.get(a.kind) ?? null);
    });
    await vi.advanceTimersByTimeAsync(80_000);
    expect([...seen.keys()].sort()).toEqual(['idle', 'thinking', 'tool']);
    expect(seen.get('tool')).toBeTruthy();
    // The others are listed as the real store lists unopened sessions: idle since the last write.
    for (const other of store.listSessions().filter((x) => x.id !== DEMO_SESSION_ID)) {
      if (other.live === 'idle')
        expect(other.activity).toMatchObject({ kind: 'idle', since: other.updatedAt });
      else expect(other).not.toHaveProperty('activity');
    }
  });

  it('stops notifying after unsubscribe and after stop', async () => {
    const patches: SessionPatch[] = [];
    const lists: SessionSummary[][] = [];
    const off = store.onPatch(DEMO_SESSION_ID, (p) => patches.push(p));
    store.onSessions((l) => lists.push(l));
    await vi.advanceTimersByTimeAsync(2000);
    off();
    await vi.advanceTimersByTimeAsync(2000);
    expect(patches).toHaveLength(1);

    await store.stop();
    const seen = lists.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lists).toHaveLength(seen);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands out copies, so callers cannot corrupt its state', async () => {
    const a = (await store.getSnapshot(DEMO_SESSION_ID)) as SessionSnapshot;
    a.requests.length = 0;
    const b = (await store.getSnapshot(DEMO_SESSION_ID)) as SessionSnapshot;
    expect(b.requests.length).toBeGreaterThan(0);
  });
});

describe('DemoStore token rate', () => {
  it('has an hour of believable history from the start, Claude Code first', () => {
    const rate = store.getRate();
    expect(Object.keys(rate.agents).sort()).toEqual(['claude-code', 'codex', 'grok']);
    const claude = ratePerMinute(rate, { agent: 'claude-code' });
    expect(claude).toBeGreaterThan(400_000);
    expect(claude).toBeGreaterThan(ratePerMinute(rate, { agent: 'codex' }));
    expect(ratePerMinute(rate, { agent: 'codex' })).toBeGreaterThan(
      ratePerMinute(rate, { agent: 'grok' }),
    );
    // Most of the hour is filled in, not just the last minutes.
    expect(rateSeries(rate).filter((n) => n > 0).length).toBeGreaterThan(50);
  });

  it('moves with every tick, and tells its listeners', async () => {
    const before = store.getRate();
    const pushed: TokenRate[] = [];
    store.onRate((r) => pushed.push(r));
    await vi.advanceTimersByTimeAsync(6000);
    expect(pushed).toHaveLength(3);
    const after = pushed.at(-1) as TokenRate;
    expect(Date.parse(after.at)).toBeGreaterThan(Date.parse(before.at));
    expect(hourTotal(after)).not.toBe(hourTotal(before));
  });
});

describe('DemoStore quota', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-23T02:00:00.000Z') });
  });

  it('serves the demo quota of several providers', async () => {
    const demo = new DemoStore();
    expect(demo.listQuotas()).toEqual(createDemoQuotas(new Date('2026-10-23T02:00:00.000Z')));
    expect(demo.listQuotas().map((q) => q.provider)).toEqual([
      'anthropic',
      'openai',
      'xai',
      'github-copilot',
      'deepseek',
    ]);
    const off = demo.onQuota(() => {});
    off();
  });
});

describe('DemoStore.expectSession', () => {
  it('knows the demo session and nothing else', async () => {
    const demo = new DemoStore();
    expect(await demo.expectSession(DEMO_SESSION_ID)).toBe(true);
    expect(await demo.expectSession('claude-code:nope')).toBe(false);
  });
});
