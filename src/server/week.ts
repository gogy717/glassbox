/**
 * The weekly receipt's data (`GET /api/week`, contract in `src/shared/week.ts`): every session
 * of the window read once and kept, in memory only, as hourly buckets; each request slices them.
 *
 * Reading is the slow part (tens to hundreds of sessions, most never opened), so it runs two
 * sessions at a time with a yield between them, one very large session at a time, and only one
 * computation runs at once: a request for the window being read joins it, progress and all; any
 * other waits its turn, hearing meanwhile how many of its sessions are ready.
 */
import type { SessionSnapshot, SessionSummary } from '../core/model.js';
import {
  type WeekLine,
  type WeekResult,
  type WeekSession,
  type WeekWindow,
  type WeekWindowKind,
  weekWindow,
} from '../shared/week.js';
import { type SessionBuckets, sessionBucketsPausing, sliceSession } from './week-buckets.js';

/** A session read for the week, and the bytes of the files read for it (0 when it was open). */
export interface WeekRead {
  snapshot: SessionSnapshot;
  bytes: number;
}

/** What the week reads from: the real store, or the demo. */
export interface WeekStore {
  /** Every session the week may count, with its `updatedAt` and live state. */
  weekSessions(): SessionSummary[];
  /** The session as it is now; null when it is gone. */
  readSession(id: string): Promise<WeekRead | null>;
  /** Bytes a read of the session would go through (0 when nothing is read: an open session). */
  sizeOf?(id: string): Promise<number>;
}

export interface WeekOptions {
  /** Sessions read at once. */
  concurrency?: number;
  /** A session this large (bytes) is read alone: two at once would hold both in memory. */
  bigBytes?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export type WeekProgress = Extract<WeekLine, { type: 'progress' }>;

interface Cached {
  buckets: SessionBuckets;
  /** The listed `updatedAt` the buckets were read at: refresh reads again when it moved on. */
  updatedAt: string;
  /** When the buckets were last known to be the session's: read then, or found unchanged. */
  readAt: number;
}

interface Job {
  kind: WeekWindowKind;
  refresh: boolean;
  promise: Promise<WeekResult>;
  listeners: Set<(p: WeekProgress) => void>;
  last: WeekProgress;
}

/** Which sessions a computation counts, and which of them it has to read. */
interface Plan {
  window: WeekWindow;
  wanted: SessionSummary[];
  toRead: SessionSummary[];
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Busy or waiting: it may be working in files its `updatedAt` does not follow. */
const running = (s: SessionSummary) => s.live === 'busy' || s.live === 'waiting';

/** `onProgress` with `done` held from going down (a plan can shrink when it is made again). */
function steady(onProgress?: (p: WeekProgress) => void) {
  if (!onProgress) return undefined;
  let last = 0;
  return (p: WeekProgress) => {
    last = Math.min(p.total, Math.max(last, p.done));
    onProgress({ type: 'progress', done: last, total: p.total });
  };
}

export class WeekService {
  private readonly cache = new Map<string, Cached>();
  private job: Job | null = null;
  private stopped = false;
  /** One very large read at a time: the next waits for this to settle. */
  private bigRead: Promise<void> = Promise.resolve();
  private readonly concurrency: number;
  private readonly bigBytes: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly store: WeekStore,
    opts: WeekOptions = {},
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.bigBytes = opts.bigBytes ?? 64 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** No more reading: a computation under way ends at its next session, and none starts. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * The window's figures. `onProgress` hears where the reading is at once, then after each
   * session read; `done` never goes down.
   */
  async compute(
    kind: WeekWindowKind,
    opts: { refresh?: boolean } = {},
    onProgress?: (p: WeekProgress) => void,
  ): Promise<WeekResult> {
    const refresh = opts.refresh === true;
    const hear = steady(onProgress);
    for (;;) {
      if (this.stopped) throw new Error('stopped');
      const current = this.job;
      if (!current) break;
      // A refresh answers a plain request too; a plain one does not answer a refresh.
      if (current.kind === kind && (current.refresh || !refresh)) return this.join(current, hear);
      // Another window is being read: say how many of this one's sessions are ready, and keep
      // saying as that reading fills the cache, until this one's turn comes.
      const plan = this.plan(kind, refresh, this.now());
      const ready = () => {
        const left = new Set(this.plan(kind, refresh, this.now()).toRead.map((s) => s.id));
        return plan.wanted.filter((s) => !left.has(s.id)).length;
      };
      const tell = () => hear?.({ type: 'progress', done: ready(), total: plan.wanted.length });
      tell();
      current.listeners.add(tell);
      try {
        await current.promise.catch(() => {});
      } finally {
        current.listeners.delete(tell);
      }
    }
    return this.join(this.start(kind, refresh), hear);
  }

  private start(kind: WeekWindowKind, refresh: boolean): Job {
    const job: Job = {
      kind,
      refresh,
      listeners: new Set(),
      last: { type: 'progress', done: 0, total: 0 },
      promise: Promise.resolve() as unknown as Promise<WeekResult>,
    };
    this.job = job;
    job.promise = this.run(job).finally(() => {
      if (this.job === job) this.job = null;
    });
    return job;
  }

  private async join(job: Job, onProgress?: (p: WeekProgress) => void): Promise<WeekResult> {
    if (onProgress) {
      job.listeners.add(onProgress);
      onProgress(job.last);
    }
    try {
      return await job.promise;
    } finally {
      if (onProgress) job.listeners.delete(onProgress);
    }
  }

  /**
   * The sessions a window counts: those last written since it began, and every running one; to
   * read, those not read yet and, on a refresh, those changed since and every running one.
   */
  private plan(kind: WeekWindowKind, refresh: boolean, now: number): Plan {
    const window = weekWindow(kind, now);
    const from = window.hourStarts[0] ?? now;
    const wanted = this.store
      .weekSessions()
      .filter((s) => running(s) || !(Date.parse(s.updatedAt) < from));
    const toRead = wanted.filter((s) => {
      const c = this.cache.get(s.id);
      return !c || (refresh && (running(s) || c.updatedAt !== s.updatedAt));
    });
    return { window, wanted, toRead };
  }

  /** Forgets sessions no longer listed, and finished ones written before both windows began. */
  private prune(listed: SessionSummary[], now: number): void {
    const oldest = Math.min(
      ...(['week', '7d'] as const).map((k) => weekWindow(k, now).hourStarts[0] ?? now),
    );
    const keep = new Set(
      listed.filter((s) => running(s) || !(Date.parse(s.updatedAt) < oldest)).map((s) => s.id),
    );
    for (const id of this.cache.keys()) if (!keep.has(id)) this.cache.delete(id);
  }

  /** Reads one session into the cache; its bytes, or null when it could not be read. */
  private async read(s: SessionSummary): Promise<number | null> {
    const big = this.store.sizeOf ? (await this.store.sizeOf(s.id)) >= this.bigBytes : false;
    let release = () => {};
    if (big) {
      const before = this.bigRead;
      this.bigRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      await before;
    }
    try {
      if (this.stopped) return null;
      const got = await this.store.readSession(s.id);
      if (!got || this.stopped) return null;
      const readAt = this.now();
      const buckets = await sessionBucketsPausing(got.snapshot, readAt, yieldToLoop);
      if (this.stopped) return null;
      this.cache.set(s.id, { buckets, updatedAt: s.updatedAt, readAt });
      return got.bytes;
    } finally {
      release();
    }
  }

  private async run(job: Job): Promise<WeekResult> {
    const started = performance.now();
    const now = this.now();
    this.prune(this.store.weekSessions(), now);
    const { window, wanted, toRead } = this.plan(job.kind, job.refresh, now);
    const total = wanted.length;
    let done = total - toRead.length;
    const emit = () => {
      job.last = { type: 'progress', done, total };
      for (const cb of job.listeners) cb(job.last);
    };
    emit();

    let read = 0;
    let failed = 0;
    let bytes = 0;
    let next = 0;
    const worker = async () => {
      for (let s = toRead[next++]; s && !this.stopped; s = toRead[next++]) {
        try {
          const got = await this.read(s);
          if (got === null) failed++;
          else {
            bytes += got;
            read++;
          }
        } catch (err) {
          failed++;
          this.log(`week: could not read ${s.id}: ${err instanceof Error ? err.message : err}`);
        }
        done++;
        emit();
        // Between sessions, let the live view's requests and events through.
        await yieldToLoop();
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, toRead.length) }, worker));
    if (this.stopped) throw new Error('stopped');

    // A finished session listed with the `updatedAt` it was read at is the same as then: known
    // good as of now. A running one is only as good as its last read.
    const reread = new Set(toRead.map((s) => s.id));
    const sessions: WeekSession[] = [];
    let asOf = now;
    for (const s of wanted) {
      const c = this.cache.get(s.id);
      if (!c) continue;
      if (!reread.has(s.id) && !running(s) && c.updatedAt === s.updatedAt) c.readAt = now;
      const row = sliceSession(c.buckets, window, s.tags ?? []);
      if (!row) continue;
      sessions.push(row);
      asOf = Math.min(asOf, c.readAt);
    }
    sessions.sort(
      (a, b) =>
        b.inWindow.agentMs - a.inWindow.agentMs || b.inWindow.activeMs - a.inWindow.activeMs,
    );
    return {
      window,
      sessions,
      asOf,
      stats: {
        considered: total,
        read,
        cached: total - toRead.length,
        failed,
        bytes,
        ms: Math.round(performance.now() - started),
      },
    };
  }
}
