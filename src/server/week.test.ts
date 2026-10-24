import { describe, expect, it } from 'vitest';
import { createDemoSideSnapshots, createDemoSnapshot } from '../core/fixtures/demo.js';
import type { SessionSnapshot } from '../core/model.js';
import { type WeekProgress, type WeekRead, WeekService, type WeekStore } from './week.js';
import { HOUR_MS } from './week-buckets.js';

const NOW = new Date(2026, 9, 24, 20, 41).getTime(); // Sat 24 Oct
const DAY = 24 * HOUR_MS;

/** A store of fixture sessions that counts reads and can hold them until told to go on. */
function fakeStore(snaps: SessionSnapshot[]) {
  const reads: string[] = [];
  let open = 0;
  let maxOpen = 0;
  let gate: Promise<void> | null = null;
  let release = () => {};
  const failing = new Set<string>();
  const store: WeekStore = {
    weekSessions: () => snaps.map((s) => s.session),
    readSession: async (id): Promise<WeekRead | null> => {
      reads.push(id);
      open++;
      maxOpen = Math.max(maxOpen, open);
      try {
        if (gate) await gate;
        await new Promise((r) => setTimeout(r, 1));
        if (failing.has(id)) throw new Error('unreadable');
        const snap = snaps.find((s) => s.session.id === id);
        return snap ? { snapshot: structuredClone(snap), bytes: 1000 } : null;
      } finally {
        open--;
      }
    },
  };
  return {
    store,
    reads,
    failing,
    maxOpen: () => maxOpen,
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

/** The demo session and its two finished neighbours, renamed apart, as of `at`. */
function week(at: number): SessionSnapshot[] {
  const main = createDemoSnapshot(new Date(at));
  const sides = createDemoSideSnapshots(new Date(at));
  return [main, ...sides];
}

/** A finished session `daysAgo` days before NOW (last written 2 hours before that). */
function old(daysAgo: number, id: string): SessionSnapshot {
  const [side] = createDemoSideSnapshots(new Date(NOW - daysAgo * DAY));
  if (!side) throw new Error('no side session');
  side.session = { ...side.session, id };
  return side;
}

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

  it('does not read a session last written before the window', async () => {
    const f = fakeStore([old(1, 'recent'), old(30, 'last-month')]);
    const r = await new WeekService(f.store, { now: () => NOW }).compute('7d');
    expect(f.reads).toEqual(['recent']);
    expect(r.stats.considered).toBe(1);
  });

  it('switches windows without reading again, and refresh reads only what changed', async () => {
    // Sat 24 Oct: this week starts Mon 19 Oct; a session of Sat 17 Oct is only in the last 7 days.
    const snaps = [old(0.5, 'today'), old(2, 'thursday'), old(6.9, 'last-saturday')];
    const f = fakeStore(snaps);
    let now = NOW;
    const svc = new WeekService(f.store, { now: () => now });
    const w = await svc.compute('week');
    expect(f.reads.sort()).toEqual(['thursday', 'today']);
    const d7 = await svc.compute('7d');
    expect(f.reads.sort()).toEqual(['last-saturday', 'thursday', 'today']);
    expect(d7.stats).toMatchObject({ read: 1, cached: 2 });
    expect(w.window.hourStarts).toHaveLength(168);
    expect(d7.window.hourStarts).toHaveLength(169);

    // One session moves on: a plain open still serves what was read, as of then.
    const moved = snaps[0] as SessionSnapshot;
    moved.session = { ...moved.session, updatedAt: new Date(NOW + 60_000).toISOString() };
    now = NOW + 120_000;
    const again = await svc.compute('week');
    expect(f.reads).toHaveLength(3);
    expect(again.asOf).toBe(NOW);
    const refreshed = await svc.compute('week', { refresh: true });
    expect(f.reads.filter((id) => id === 'today')).toHaveLength(2);
    expect(refreshed.stats).toMatchObject({ read: 1, cached: 1 });
  });

  it('runs a request for another window after the one being read, not alongside it', async () => {
    const f = fakeStore([old(1, 'a'), old(2, 'b')]);
    const svc = new WeekService(f.store, { now: () => NOW });
    f.hold();
    const w = svc.compute('week');
    const d7 = svc.compute('7d');
    await new Promise((r) => setTimeout(r, 5));
    expect(f.reads).toHaveLength(2);
    f.go();
    await Promise.all([w, d7]);
    expect(f.reads).toHaveLength(2);
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
