import { describe, expect, it, vi } from 'vitest';
import type { WeekResult, WeekWindowKind } from '../../../src/shared/week.js';
import { demoWeek } from '../test/week';
import { createWeekCache, type ReadWeek } from './weeks';

/** A read held open until the test settles it: its progress, result or failure, and its signal. */
interface Pending {
  kind: WeekWindowKind;
  refresh: boolean;
  signal: AbortSignal | undefined;
  progress(done: number, total: number): void;
  resolve(r: WeekResult): void;
  reject(e: Error): void;
}

function held() {
  const reads: Pending[] = [];
  const read: ReadWeek = (kind, refresh, onProgress, signal) =>
    new Promise((resolve, reject) => {
      reads.push({ kind, refresh, signal, progress: onProgress, resolve, reject });
    });
  return { reads, read };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the week cache', () => {
  it('reads a window, saying how far it got, and keeps its result', async () => {
    const { reads, read } = held();
    const weeks = createWeekCache(read);
    const seen = vi.fn();
    weeks.subscribe(seen);
    weeks.request('week');
    expect(weeks.get().week).toEqual({
      result: null,
      reading: { done: 0, total: 0, refresh: false },
      failed: null,
    });
    reads[0]?.progress(3, 12);
    expect(weeks.get().week?.reading).toEqual({ done: 3, total: 12, refresh: false });
    const r = demoWeek('week');
    reads[0]?.resolve(r);
    await settle();
    expect(weeks.get().week).toEqual({ result: r, reading: null, failed: null });
    expect(weeks.get()['7d']).toBeUndefined();
    expect(seen).toHaveBeenCalled();
  });

  it('never reads a window twice at once: a request while one is under way is passed over', () => {
    const { reads, read } = held();
    const weeks = createWeekCache(read);
    weeks.request('week');
    weeks.request('week');
    weeks.request('week', { refresh: true });
    expect(reads).toHaveLength(1);
    // Each window on its own.
    weeks.request('7d');
    expect(reads.map((r) => r.kind)).toEqual(['week', '7d']);
  });

  it('asks the server to parse running sessions again only on a refresh', () => {
    const { reads, read } = held();
    const weeks = createWeekCache(read);
    weeks.request('7d', { refresh: true });
    expect(reads[0]?.refresh).toBe(true);
    expect(weeks.get()['7d']?.reading?.refresh).toBe(true);
  });

  it('keeps the last result through a read again, and through its failure, saying why', async () => {
    const { reads, read } = held();
    const weeks = createWeekCache(read);
    const r = demoWeek('week');
    weeks.request('week');
    reads[0]?.resolve(r);
    await settle();
    weeks.request('week');
    expect(weeks.get().week?.result).toBe(r);
    reads[1]?.reject(new Error('HTTP 500'));
    await settle();
    expect(weeks.get().week).toEqual({ result: r, reading: null, failed: 'HTTP 500' });
    // The failure stays said while the week is read again (not taken back and said anew each
    // minute, M4), and goes once a read succeeds.
    weeks.request('week');
    expect(weeks.get().week?.failed).toBe('HTTP 500');
    reads[2]?.resolve(r);
    await settle();
    expect(weeks.get().week?.failed).toBeNull();
  });

  it('runs a refresh asked during a read once that read is done, never dropping it (M5)', async () => {
    const { reads, read } = held();
    const weeks = createWeekCache(read);
    weeks.request('week');
    weeks.request('week', { refresh: true });
    weeks.request('week');
    expect(reads).toHaveLength(1);
    reads[0]?.resolve(demoWeek('week'));
    await settle();
    expect(reads.map((x) => x.refresh)).toEqual([false, true]);
    // Only once: the plain request asked meanwhile is the minute's, and the refresh covers it.
    reads[1]?.resolve(demoWeek('week'));
    await settle();
    expect(reads).toHaveLength(2);
  });

  it('drops a queued refresh when nothing shows its window any more', async () => {
    const { reads, read } = held();
    const weeks = createWeekCache(read);
    const release = weeks.retain('week');
    weeks.request('week');
    weeks.request('week', { refresh: true });
    release();
    reads[0]?.resolve(demoWeek('week'));
    await settle();
    expect(reads).toHaveLength(1);
  });

  it('stops a read once nothing on the page shows its window, and not before', async () => {
    const { reads, read } = held();
    const weeks = createWeekCache(read);
    const stats = weeks.retain('week');
    const dialog = weeks.retain('week');
    weeks.request('week');
    dialog();
    dialog(); // Letting go twice counts once.
    expect(reads[0]?.signal?.aborted).toBe(false);
    stats();
    expect(reads[0]?.signal?.aborted).toBe(true);
    expect(weeks.get().week?.reading).toBeNull();
    // What an aborted read brings back is dropped; the next request reads afresh.
    reads[0]?.resolve(demoWeek('week'));
    await settle();
    expect(weeks.get().week?.result).toBeNull();
    weeks.request('week');
    expect(reads).toHaveLength(2);
  });

  it('lets a read nobody holds run to its end', async () => {
    const { reads, read } = held();
    const weeks = createWeekCache(read);
    weeks.retain('7d')();
    weeks.request('week');
    const r = demoWeek('week');
    reads[0]?.resolve(r);
    await settle();
    expect(weeks.get().week?.result).toBe(r);
  });
});
