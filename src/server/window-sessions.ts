/**
 * Reading a window's sessions, shared by the week (`week.ts`) and Rules (`rules.ts`): which of
 * them are not known to be as cached, and the reading of those, the smallest first, a few at a
 * time with a yield between them and one very large session at a time, a running one parsed
 * again no sooner than `reparseMs` unless a refresh asks. What a session read becomes is the
 * caller's (`keep`); so are the window, the cache and the progress.
 */
import type { SessionSummary } from '../core/model.js';
import { isActive } from './live.js';
import type { WeekRead, WeekStore } from './week.js';

/** What a cache entry says about when its session was read. */
export interface WindowCached {
  /** The listed `updatedAt` it was read at: read again if it moved. */
  updatedAt: string;
  /** When it was read (the computation's time): a running session's next parse waits. */
  readAt: number;
  /** It was running when read: its files may have grown since whatever its `updatedAt` says. */
  running: boolean;
}

export const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Busy or waiting: it may be working in files its `updatedAt` does not follow. */
export const running = (s: SessionSummary) => isActive(s.live);

/**
 * Of a window's sessions, those not known to be as cached: not read yet, changed since (by their
 * `updatedAt`), running now, or running when they were read.
 */
export function staleSessions(
  wanted: SessionSummary[],
  cache: ReadonlyMap<string, WindowCached>,
): SessionSummary[] {
  return wanted.filter((s) => {
    const c = cache.get(s.id);
    return !c || running(s) || c.running || c.updatedAt !== s.updatedAt;
  });
}

/** One very large read at a time: the next waits for the last to settle. */
export class BigReads {
  private last: Promise<void> = Promise.resolve();

  /** Runs `read`, after the last big one when `big`. */
  async run<T>(big: boolean, read: () => Promise<T>): Promise<T> {
    if (!big) return read();
    const before = this.last;
    let release = () => {};
    this.last = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await read();
    } finally {
      release();
    }
  }
}

export interface ReadWindowOptions<C extends WindowCached> {
  store: WeekStore;
  /** The sessions to read, as `staleSessions` finds them. */
  stale: SessionSummary[];
  cache: ReadonlyMap<string, C>;
  /** The computation's time: what a session is read as of. */
  now: number;
  refresh: boolean;
  reparseMs: number;
  concurrency: number;
  /** A session this large (bytes) is read alone. */
  bigBytes: number;
  bigReads: BigReads;
  stopped: () => boolean;
  log: (msg: string) => void;
  /** Starts each log line (`week`, `rules`). */
  label: string;
  /** Progress: this many more sessions are done. */
  advance: (by: number) => void;
  /** Turns a session read into the cache; false when it was not kept (stopped meanwhile). */
  keep: (s: SessionSummary, got: WeekRead, asOf: number) => Promise<boolean>;
}

export interface WindowReads {
  /** Sessions it set out to read: the rest of the window counts as cached. */
  tried: number;
  read: number;
  failed: number;
  /** Bytes of the files read. */
  bytes: number;
}

/** Reads the stale sessions that need it into the caller's cache, and counts the reading. */
export async function readWindowSessions<C extends WindowCached>(
  o: ReadWindowOptions<C>,
): Promise<WindowReads> {
  // Open sessions are read again from memory every time; a running one that has to be parsed,
  // no sooner than `reparseMs` after its last parse, unless a refresh asks.
  const sizeOf = o.store.sizeOf?.bind(o.store);
  const sized = await Promise.all(
    o.stale.map(async (s) => ({ s, size: sizeOf ? await sizeOf(s.id).catch(() => 0) : 0 })),
  );
  const toRead = sized.filter(({ s, size }) => {
    const c = o.cache.get(s.id);
    return !c || o.refresh || size === 0 || !(running(s) && o.now - c.readAt < o.reparseMs);
  });
  if (toRead.length < sized.length) o.advance(sized.length - toRead.length);
  // The smallest first: a large session waits for the small ones, never the other way.
  toRead.sort((a, b) => a.size - b.size);

  const readOne = (s: SessionSummary, size: number): Promise<number | null> =>
    o.bigReads.run(size >= o.bigBytes, async () => {
      if (o.stopped()) return null;
      const got = await o.store.readSession(s.id);
      if (!got || o.stopped()) return null;
      return (await o.keep(s, got, o.now)) ? got.bytes : null;
    });

  const counts: WindowReads = { tried: toRead.length, read: 0, failed: 0, bytes: 0 };
  let next = 0;
  const worker = async () => {
    for (let item = toRead[next++]; item && !o.stopped(); item = toRead[next++]) {
      const { s, size } = item;
      try {
        const got = await readOne(s, size);
        if (got === null) counts.failed++;
        else {
          counts.bytes += got;
          counts.read++;
        }
      } catch (err) {
        counts.failed++;
        o.log(`${o.label}: could not read ${s.id}: ${err instanceof Error ? err.message : err}`);
      }
      o.advance(1);
      // Between sessions, let the live view's requests and events through.
      await yieldToLoop();
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency, toRead.length) }, worker));
  return counts;
}
