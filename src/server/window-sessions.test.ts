import { describe, expect, it } from 'vitest';
import { createDemoSideSnapshots } from '../core/fixtures/demo.js';
import type { LiveState, SessionSummary } from '../core/model.js';
import type { WeekRead, WeekStore } from './week.js';
import {
  BigReads,
  readWindowSessions,
  staleSessions,
  type WindowCached,
} from './window-sessions.js';

const NOW = new Date(2026, 10, 21, 20, 41).getTime();

/** A listed session `id`, synthetic, with the live state and `updatedAt` asked. */
function summary(id: string, live: LiveState = 'idle', updatedAt = '2026-11-21T08:00:00.000Z') {
  const [side] = createDemoSideSnapshots(new Date(NOW));
  if (!side) throw new Error('no side session');
  return { ...side.session, id, live, updatedAt } as SessionSummary;
}

/** A store over `list` that records reads, says the size asked, and can fail a read. */
function fakeStore(list: SessionSummary[], sizes: Record<string, number> = {}) {
  const reads: string[] = [];
  const failing = new Set<string>();
  const gone = new Set<string>();
  let bigOpen = 0;
  let maxBig = 0;
  const [side] = createDemoSideSnapshots(new Date(NOW));
  const store: WeekStore = {
    weekSessions: () => list,
    readSession: async (id): Promise<WeekRead | null> => {
      reads.push(id);
      const big = (sizes[id] ?? 0) >= 100;
      if (big) bigOpen++;
      maxBig = Math.max(maxBig, bigOpen);
      try {
        await new Promise((r) => setTimeout(r, big ? 15 : 1));
        if (failing.has(id)) throw new Error('unreadable');
        if (gone.has(id) || !side) return null;
        return { snapshot: structuredClone(side), bytes: sizes[id] ?? 10 };
      } finally {
        if (big) bigOpen--;
      }
    },
    sizeOf: async (id) => sizes[id] ?? 10,
  };
  return { store, reads, failing, gone, maxBig: () => maxBig };
}

function options(store: WeekStore, stale: SessionSummary[], extra = {}) {
  const advanced: number[] = [];
  const kept: string[] = [];
  const logs: string[] = [];
  return {
    advanced,
    kept,
    logs,
    opts: {
      store,
      stale,
      cache: new Map<string, WindowCached>(),
      now: NOW,
      refresh: false,
      reparseMs: 30_000,
      concurrency: 2,
      bigBytes: 100,
      bigReads: new BigReads(),
      stopped: () => false,
      log: (m: string) => logs.push(m),
      label: 'test',
      advance: (by: number) => advanced.push(by),
      keep: async (s: SessionSummary) => {
        kept.push(s.id);
        return true;
      },
      ...extra,
    },
  };
}

describe('the sessions of a window', () => {
  it('are stale when not cached, changed since, running now, or running when read', () => {
    const list = [
      summary('new'),
      summary('same'),
      summary('moved', 'idle', '2026-11-21T09:00:00.000Z'),
      summary('busy', 'busy'),
      summary('was-running'),
    ];
    const at = '2026-11-21T08:00:00.000Z';
    const cache = new Map<string, WindowCached>([
      ['same', { updatedAt: at, readAt: NOW, running: false }],
      ['moved', { updatedAt: at, readAt: NOW, running: false }],
      ['busy', { updatedAt: at, readAt: NOW, running: false }],
      ['was-running', { updatedAt: at, readAt: NOW, running: true }],
    ]);
    expect(staleSessions(list, cache).map((s) => s.id)).toEqual([
      'new',
      'moved',
      'busy',
      'was-running',
    ]);
  });

  it('are read smallest first, each kept through the caller, and counted', async () => {
    const list = [summary('c'), summary('a'), summary('b')];
    const f = fakeStore(list, { a: 1, b: 2, c: 3 });
    const o = options(f.store, list, { concurrency: 1 });
    const got = await readWindowSessions(o.opts);
    expect(f.reads).toEqual(['a', 'b', 'c']);
    expect(o.kept).toEqual(['a', 'b', 'c']);
    expect(got).toEqual({ tried: 3, read: 3, failed: 0, bytes: 6 });
    expect(o.advanced).toEqual([1, 1, 1]);
  });

  it('leave a running session parsed within reparseMs alone, unless a refresh asks', async () => {
    const list = [summary('busy', 'busy'), summary('idle')];
    const cache = new Map<string, WindowCached>([
      ['busy', { updatedAt: list[0]?.updatedAt ?? '', readAt: NOW - 1000, running: true }],
    ]);
    const f = fakeStore(list);
    const o = options(f.store, list, { cache });
    const got = await readWindowSessions(o.opts);
    expect(f.reads).toEqual(['idle']);
    expect(got.tried).toBe(1);
    // The one left alone counts as done at once, before any read.
    expect(o.advanced).toEqual([1, 1]);

    const r = options(f.store, list, { cache, refresh: true });
    expect((await readWindowSessions(r.opts)).tried).toBe(2);
  });

  it('count a session that cannot be read, gone, or not kept as failed, and log a throw', async () => {
    const list = [summary('bad'), summary('gone'), summary('dropped'), summary('fine')];
    const f = fakeStore(list);
    f.failing.add('bad');
    f.gone.add('gone');
    const o = options(f.store, list, {
      keep: async (s: SessionSummary) => s.id !== 'dropped',
    });
    const got = await readWindowSessions(o.opts);
    expect(got).toEqual({ tried: 4, read: 1, failed: 3, bytes: 10 });
    expect(o.logs).toEqual(['test: could not read bad: unreadable']);
    expect(o.advanced).toEqual([1, 1, 1, 1]);
  });

  it('read a very large session alone, across calls sharing the same BigReads', async () => {
    const list = [summary('big1'), summary('big2'), summary('small')];
    const f = fakeStore(list, { big1: 100, big2: 200, small: 1 });
    const bigReads = new BigReads();
    const a = options(f.store, [list[0] as SessionSummary, list[2] as SessionSummary], {
      bigReads,
    });
    const b = options(f.store, [list[1] as SessionSummary], { bigReads });
    await Promise.all([readWindowSessions(a.opts), readWindowSessions(b.opts)]);
    expect(f.maxBig()).toBe(1);
    expect(f.reads.sort()).toEqual(['big1', 'big2', 'small']);
  });

  it('read nothing more once stopped, and keep nothing read after', async () => {
    const list = [summary('a'), summary('b'), summary('c')];
    const f = fakeStore(list, { a: 1, b: 2, c: 3 });
    let stop = false;
    const o = options(f.store, list, {
      concurrency: 1,
      stopped: () => stop,
      keep: async (s: SessionSummary) => {
        o.kept.push(s.id);
        stop = true;
        return true;
      },
    });
    const got = await readWindowSessions(o.opts);
    expect(f.reads).toEqual(['a']);
    expect(o.kept).toEqual(['a']);
    expect(got.read).toBe(1);
  });
});
