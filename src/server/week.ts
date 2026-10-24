/**
 * The weekly receipt's data (`GET /api/week`, contract in `src/shared/week.ts`): every session
 * of the window read once and kept, in memory only, as hourly buckets; each request slices them.
 *
 * Reading is the slow part (tens to hundreds of sessions, most never opened), so it runs two
 * sessions at a time with a yield between them, and only one computation runs at once: a request
 * for the window being read joins it, progress and all; any other waits its turn.
 */
import type { SessionSnapshot, SessionSummary } from '../core/model.js';
import type { WeekLine, WeekResult, WeekSession, WeekWindowKind } from '../shared/week.js';
import { type SessionBuckets, sessionBuckets, sliceSession, weekWindow } from './week-buckets.js';

/** A session read for the week, and the bytes of the files read for it (0 when it was open). */
export interface WeekRead {
  snapshot: SessionSnapshot;
  bytes: number;
}

/** What the week reads from: the real store, or the demo. */
export interface WeekStore {
  /** Every session the week may count, with its `updatedAt`. */
  weekSessions(): SessionSummary[];
  /** The session as it is now; null when it is gone. */
  readSession(id: string): Promise<WeekRead | null>;
}

export interface WeekOptions {
  /** Sessions read at once. */
  concurrency?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export type WeekProgress = Extract<WeekLine, { type: 'progress' }>;

interface Cached {
  buckets: SessionBuckets;
  /** The listed `updatedAt` the buckets were read at: refresh reads again when it moved on. */
  updatedAt: string;
  readAt: number;
}

interface Job {
  kind: WeekWindowKind;
  refresh: boolean;
  promise: Promise<WeekResult>;
  listeners: Set<(p: WeekProgress) => void>;
  last: WeekProgress;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export class WeekService {
  private readonly cache = new Map<string, Cached>();
  private job: Job | null = null;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly store: WeekStore,
    opts: WeekOptions = {},
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
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
    for (;;) {
      const running = this.job;
      if (!running) break;
      // A refresh answers a plain request too; a plain one does not answer a refresh.
      if (running.kind === kind && (running.refresh || !refresh))
        return this.join(running, onProgress);
      await running.promise.catch(() => {});
    }
    return this.join(this.start(kind, refresh), onProgress);
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

  private async run(job: Job): Promise<WeekResult> {
    const started = performance.now();
    const now = this.now();
    const window = weekWindow(job.kind, now);
    const from = window.hourStarts[0] ?? now;
    const listed = this.store.weekSessions();
    const ids = new Set(listed.map((s) => s.id));
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
    // A session last written before the window starts has nothing in it: not read at all.
    const wanted = listed.filter((s) => !(Date.parse(s.updatedAt) < from));
    const toRead = wanted.filter((s) => {
      const c = this.cache.get(s.id);
      return !c || (job.refresh && c.updatedAt !== s.updatedAt);
    });
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
      for (let s = toRead[next++]; s; s = toRead[next++]) {
        try {
          const got = await this.store.readSession(s.id);
          if (got) {
            const readAt = this.now();
            const buckets = sessionBuckets(got.snapshot, readAt);
            this.cache.set(s.id, { buckets, updatedAt: s.updatedAt, readAt });
            bytes += got.bytes;
            read++;
          } else failed++;
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

    const sessions: WeekSession[] = [];
    let asOf = now;
    for (const s of wanted) {
      const c = this.cache.get(s.id);
      const row = c && sliceSession(c.buckets, window);
      if (!c || !row) continue;
      sessions.push(row);
      asOf = Math.min(asOf, c.readAt);
    }
    sessions.sort(
      (a, b) =>
        b.inWindow.activeMs - a.inWindow.activeMs || b.inWindow.agentMs - a.inWindow.agentMs,
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
