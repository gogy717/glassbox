import { describe, expect, it } from 'vitest';
import { createDemoSideSnapshots, createDemoSnapshot } from '../core/fixtures/demo.js';
import type { SessionSnapshot } from '../core/model.js';
import { type WeekProgress, type WeekRead, WeekService, type WeekStore } from './week.js';
import { HOUR_MS } from './week-buckets.js';

// Sat 21 Nov: no common time zone changes its clocks this week or the one before, so the tests
// read the same wherever they run.
const NOW = new Date(2026, 10, 21, 20, 41).getTime();
const DAY = 24 * HOUR_MS;
const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * A store of fixture sessions that counts reads, can hold them until told to go on, and says how
 * large each would be.
 */
function fakeStore(snaps: SessionSnapshot[], sizes: Record<string, number> = {}) {
  const reads: string[] = [];
  let open = 0;
  let maxOpen = 0;
  let bigOpen = 0;
  let maxBig = 0;
  let gate: Promise<void> | null = null;
  let release = () => {};
  const failing = new Set<string>();
  const store: WeekStore = {
    weekSessions: () => snaps.map((s) => s.session),
    readSession: async (id): Promise<WeekRead | null> => {
      reads.push(id);
      const big = (sizes[id] ?? 0) > 0;
      open++;
      if (big) bigOpen++;
      maxOpen = Math.max(maxOpen, open);
      maxBig = Math.max(maxBig, bigOpen);
      try {
        if (gate) await gate;
        // A large session takes a while to read: long enough for another to start meanwhile.
        await new Promise((r) => setTimeout(r, big ? 20 : 1));
        if (failing.has(id)) throw new Error('unreadable');
        const snap = snaps.find((s) => s.session.id === id);
        return snap ? { snapshot: structuredClone(snap), bytes: 1000 } : null;
      } finally {
        open--;
        if (big) bigOpen--;
      }
    },
    sizeOf: async (id) => sizes[id] ?? 1000,
  };
  return {
    store,
    reads,
    failing,
    maxOpen: () => maxOpen,
    maxBig: () => maxBig,
    count: (id: string) => reads.filter((r) => r === id).length,
    hold: () => {
      gate = new Promise((r) => {
        release = r;
      });
    },
    go: () => {
      gate = null;
      release();
    },
  };
}

/** The demo session (busy) and its two finished neighbours, as of `at`. */
function week(at: number): SessionSnapshot[] {
  return [createDemoSnapshot(new Date(at)), ...createDemoSideSnapshots(new Date(at))];
}

/** A finished session `daysAgo` days before NOW (last written 95 minutes before that). */
function old(daysAgo: number, id: string): SessionSnapshot {
  const [side] = createDemoSideSnapshots(new Date(NOW - daysAgo * DAY));
  if (!side) throw new Error('no side session');
  side.session = { ...side.session, id };
  return side;
}

/** `snap` written again at `at`, as discovery would list it. */
const touched = (snap: SessionSnapshot, at: number) => {
  snap.session = { ...snap.session, updatedAt: new Date(at).toISOString() };
};

describe('the weekly receipt’s data', () => {
  it('reads each session once for requests made together, and they share the progress', async () => {
    const f = fakeStore(week(NOW));
    const svc = new WeekService(f.store, { now: () => NOW });
    const a: WeekProgress[] = [];
    const b: WeekProgress[] = [];
    f.hold();
    const first = svc.compute('week', {}, (p) => a.push(p));
    const second = svc.compute('week', {}, (p) => b.push(p));
    // Progress is there before any session is read.
    expect(a[0]).toEqual({ type: 'progress', done: 0, total: 3 });
    expect(b[0]).toEqual({ type: 'progress', done: 0, total: 3 });
    f.go();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toBe(r2);
    expect(f.reads.sort()).toEqual(
      week(NOW)
        .map((s) => s.session.id)
        .sort(),
    );
    for (const seen of [a, b]) {
      const dones = seen.map((p) => p.done);
      expect(dones).toEqual([...dones].sort((x, y) => x - y));
      expect(seen.at(-1)).toEqual({ type: 'progress', done: 3, total: 3 });
    }
    expect(r1.sessions).toHaveLength(3);
    expect(r1.stats).toMatchObject({ considered: 3, read: 3, cached: 0, failed: 0, bytes: 3000 });
  });

  it('reads two at a time', async () => {
    const snaps = Array.from({ length: 6 }, (_, i) => old(1, `s${i}`));
    const f = fakeStore(snaps);
    await new WeekService(f.store, { now: () => NOW }).compute('7d');
    expect(f.maxOpen()).toBe(2);
    expect(f.reads).toHaveLength(6);
  });

  it('reads a very large session alone, small ones still alongside (M6)', async () => {
    const snaps = ['big1', 'small1', 'big2', 'small2', 'big3'].map((id) => old(1, id));
    const f = fakeStore(snaps, { big1: 300e6, big2: 300e6, big3: 70e6 });
    await new WeekService(f.store, { now: () => NOW, bigBytes: 64e6 }).compute('7d');
    expect(f.reads).toHaveLength(5);
    expect(f.maxBig()).toBe(1);
    expect(f.maxOpen()).toBe(2);
  });

  it('does not read a finished session last written before the window', async () => {
    const f = fakeStore([old(1, 'recent'), old(30, 'last-month')]);
    const r = await new WeekService(f.store, { now: () => NOW }).compute('7d');
    expect(f.reads).toEqual(['recent']);
    expect(r.stats.considered).toBe(1);
  });

  it('reads a running session whatever its updatedAt, and again on every refresh (I3)', async () => {
    // Busy, its main file last written days ago: a background sub-agent works in its own files.
    const [live] = week(NOW);
    if (!live) throw new Error('no demo session');
    touched(live, NOW - 10 * DAY);
    const f = fakeStore([live]);
    const svc = new WeekService(f.store, { now: () => NOW });
    const r = await svc.compute('week');
    expect(f.reads).toEqual([live.session.id]);
    expect(r.sessions).toHaveLength(1);
    await svc.compute('week', { refresh: true });
    expect(f.count(live.session.id)).toBe(2);
    // A plain open serves it as read.
    await svc.compute('week');
    expect(f.count(live.session.id)).toBe(2);
  });

  it('switches windows without reading again, and refresh reads only what changed', async () => {
    // Sat 21 Nov: this week starts Mon 16 Nov; a session of Sat 14 Nov is only in the last 7 days.
    const snaps = [old(0.5, 'today'), old(2, 'thursday'), old(6.8, 'last-saturday')];
    const f = fakeStore(snaps);
    let now = NOW;
    const svc = new WeekService(f.store, { now: () => now });
    const w = await svc.compute('week');
    expect(f.reads.sort()).toEqual(['thursday', 'today']);
    const d7 = await svc.compute('7d');
    expect(f.reads.sort()).toEqual(['last-saturday', 'thursday', 'today']);
    expect(d7.stats).toMatchObject({ read: 1, cached: 2 });
    expect(w.window.hourStarts).toHaveLength(168);
    expect(d7.window.hourStarts).toHaveLength(168);

    // One session moves on: a plain open still serves what was read, as of then.
    touched(snaps[0] as SessionSnapshot, NOW + 60_000);
    now = NOW + 120_000;
    const again = await svc.compute('week');
    expect(f.reads).toHaveLength(3);
    expect(again.asOf).toBe(NOW);
    const refreshed = await svc.compute('week', { refresh: true });
    expect(f.count('today')).toBe(2);
    expect(refreshed.stats).toMatchObject({ read: 1, cached: 1 });
    expect(refreshed.asOf).toBe(now);
  });

  it('moves asOf on when a refresh finds every session unchanged (I2)', async () => {
    const f = fakeStore([old(1, 'a'), old(2, 'b')]);
    let now = NOW;
    const svc = new WeekService(f.store, { now: () => now });
    expect((await svc.compute('week')).asOf).toBe(NOW);
    now = NOW + 10 * 60_000;
    const r = await svc.compute('week', { refresh: true });
    expect(f.reads).toHaveLength(2);
    expect(r.asOf).toBe(now);
  });

  it('runs a request for another window after the one being read, not alongside it', async () => {
    const f = fakeStore([old(1, 'a'), old(2, 'b')]);
    const svc = new WeekService(f.store, { now: () => NOW });
    f.hold();
    const w = svc.compute('week');
    const d7 = svc.compute('7d');
    await tick();
    expect(f.reads).toHaveLength(2);
    f.go();
    await Promise.all([w, d7]);
    expect(f.reads).toHaveLength(2);
  });

  it('tells a request waiting its turn how many of its sessions are ready, as they are read (M7)', async () => {
    const f = fakeStore([old(1, 'a'), old(2, 'b'), old(6.8, 'c')]);
    const svc = new WeekService(f.store, { now: () => NOW, concurrency: 1 });
    const seen: WeekProgress[] = [];
    f.hold();
    const w = svc.compute('week');
    const d7 = svc.compute('7d', {}, (p) => seen.push(p));
    // At once, before the week has read anything.
    expect(seen).toEqual([{ type: 'progress', done: 0, total: 3 }]);
    f.go();
    await Promise.all([w, d7]);
    const dones = seen.map((p) => p.done);
    expect(dones).toEqual([...dones].sort((x, y) => x - y));
    // The week's reading counted for it (a, then b), then its own (c).
    expect(dones).toContain(1);
    expect(dones).toContain(2);
    expect(seen.at(-1)).toEqual({ type: 'progress', done: 3, total: 3 });
  });

  it('lets refreshes made together share one reading, and a refresh wait for a plain one (M4)', async () => {
    const snaps = [old(1, 'a')];
    const f = fakeStore(snaps);
    let now = NOW;
    const svc = new WeekService(f.store, { now: () => now });
    await svc.compute('week');
    touched(snaps[0] as SessionSnapshot, NOW + 60_000);
    now = NOW + 120_000;
    const [x, y] = await Promise.all([
      svc.compute('week', { refresh: true }),
      svc.compute('week', { refresh: true }),
    ]);
    expect(x).toBe(y);
    expect(f.count('a')).toBe(2);
    // A plain read under way does not answer a refresh: the refresh reads what changed after it.
    snaps.push(old(1, 'new'));
    touched(snaps[0] as SessionSnapshot, NOW + 180_000);
    f.hold();
    const plain = svc.compute('week');
    const fresh = svc.compute('week', { refresh: true });
    await tick();
    f.go();
    const [p, r] = await Promise.all([plain, fresh]);
    expect(p).not.toBe(r);
    expect(f.count('new')).toBe(1);
    expect(f.count('a')).toBe(3);
  });

  it('starts afresh after a computation that failed (M4)', async () => {
    const f = fakeStore([old(1, 'a')]);
    const list = f.store.weekSessions;
    let broken = true;
    f.store.weekSessions = () => {
      if (broken) {
        broken = false;
        throw new Error('disk gone');
      }
      return list();
    };
    const svc = new WeekService(f.store, { now: () => NOW });
    await expect(svc.compute('week')).rejects.toThrow('disk gone');
    expect((await svc.compute('week')).sessions).toHaveLength(1);
  });

  it('forgets a session no longer listed, and a finished one older than both windows (M4, M11)', async () => {
    const snaps = [old(1, 'a'), old(2, 'b')];
    const f = fakeStore(snaps);
    let now = NOW;
    const svc = new WeekService(f.store, { now: () => now });
    await svc.compute('7d');
    const b = snaps.pop() as SessionSnapshot;
    await svc.compute('7d');
    snaps.push(b);
    await svc.compute('7d');
    expect(f.count('b')).toBe(2);
    // Two weeks on, both are older than either window: forgotten, so read again if they count.
    now = NOW + 14 * DAY;
    await svc.compute('7d');
    now = NOW;
    await svc.compute('7d');
    expect(f.count('a')).toBe(2);
    expect(f.count('b')).toBe(3);
  });

  it('stops: a computation under way ends at its next session, and none starts after (M9)', async () => {
    const f = fakeStore([old(1, 'a'), old(1, 'b'), old(1, 'c')]);
    const svc = new WeekService(f.store, { now: () => NOW, concurrency: 1 });
    f.hold();
    const r = svc.compute('7d');
    await tick();
    svc.stop();
    f.go();
    await expect(r).rejects.toThrow('stopped');
    expect(f.reads).toHaveLength(1);
    await expect(svc.compute('week')).rejects.toThrow('stopped');
  });

  it('carries each session’s tags as listed, and whether it reports usage at all (I1, M5)', async () => {
    const probe = old(1, 'probe');
    probe.session = { ...probe.session, tags: ['probe'] };
    const silent = old(1, 'silent');
    silent.requests = silent.requests.map((q) => ({ ...q, usage: null }));
    const f = fakeStore([probe, silent, old(1, 'plain')]);
    const r = await new WeekService(f.store, { now: () => NOW }).compute('7d');
    const by = (id: string) => r.sessions.find((s) => s.id === id);
    expect(by('probe')?.tags).toEqual(['probe']);
    expect(by('plain')?.tags).toEqual([]);
    expect(by('silent')?.reportsUsage).toBe(false);
    expect(by('plain')?.reportsUsage).toBe(true);
  });

  it('leaves out a session it cannot read, and counts it', async () => {
    const f = fakeStore([old(1, 'fine'), old(1, 'broken')]);
    f.failing.add('broken');
    const logged: string[] = [];
    const r = await new WeekService(f.store, {
      now: () => NOW,
      log: (m) => logged.push(m),
    }).compute('7d');
    expect(r.sessions.map((s) => s.id)).toEqual(['fine']);
    expect(r.stats.failed).toBe(1);
    expect(logged[0]).toContain('broken');
  });
});
