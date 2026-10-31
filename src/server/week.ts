/**
 * The weekly receipt's data (`GET /api/week`, contract in `src/shared/week.ts`): every session
 * of the window read once and kept, in memory only, as hourly buckets; each request slices them.
 *
 * Reading is the slow part (tens to hundreds of sessions, most never opened), so it runs two
 * sessions at a time with a yield between them, the smallest first and one very large session at
 * a time, and only one computation runs at once: a request for the window being read joins it,
 * progress and all; any other waits its turn, hearing meanwhile how many of its sessions are
 * ready.
 */
import type { RepoIdentity, SessionSnapshot, SessionSummary } from '../core/model.js';
import type { WaitSource } from '../shared/waiting.js';
import {
  type WeekLine,
  type WeekResult,
  type WeekSession,
  type WeekWindow,
  type WeekWindowKind,
  weekWindow,
} from '../shared/week.js';
import { type SessionBuckets, sessionBucketsPausing, sliceSession } from './week-buckets.js';
import {
  BigReads,
  readWindowSessions,
  running,
  staleSessions,
  type WindowCached,
  yieldToLoop,
} from './window-sessions.js';

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
  /** The git repository of a directory, for `WeekSession.repo`; none when absent. */
  repoOf?: (cwd: string) => RepoIdentity | null;
  /** A session this large (bytes) is read alone: two at once would hold both in memory. */
  bigBytes?: number;
  /** A running session that has to be parsed is parsed again no sooner than this (ms). */
  reparseMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export type WeekProgress = Extract<WeekLine, { type: 'progress' }>;

interface Cached extends WindowCached {
  buckets: SessionBuckets;
}

interface Job {
  kind: WeekWindowKind;
  refresh: boolean;
  promise: Promise<WeekResult>;
  listeners: Set<(p: WeekProgress) => void>;
  last: WeekProgress;
}

/** Which sessions a computation counts, and which of them are not known to be as cached. */
interface Plan {
  window: WeekWindow;
  wanted: SessionSummary[];
  stale: SessionSummary[];
}

/** `onProgress` with `done` held from going down (a plan can shrink when it is made again). */
export function steady(onProgress?: (p: WeekProgress) => void) {
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
  /** One very large read at a time. */
  private readonly bigReads = new BigReads();
  private readonly concurrency: number;
  private readonly bigBytes: number;
  private readonly reparseMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly repoOf: ((cwd: string) => RepoIdentity | null) | null;
  /** What glassbox's runs know of a session's waits (`setWaitSource`). */
  private waitSourceOf: ((sessionId: string) => WaitSource | undefined) | null = null;

  constructor(
    private readonly store: WeekStore,
    opts: WeekOptions = {},
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.repoOf = opts.repoOf ?? null;
    this.bigBytes = opts.bigBytes ?? 64 * 1024 * 1024;
    this.reparseMs = opts.reparseMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Where a session's permission prompts and live stretches come from (`waitSourceOf`): the
   * glassbox runs of the server, which exist once the store does. A session already read keeps
   * what it was read with, until it is written again. Null: no permission wait and no gap
   * between prompts is known.
   */
  setWaitSource(source: ((sessionId: string) => WaitSource | undefined) | null): void {
    this.waitSourceOf = source;
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
      const plan = this.plan(kind, this.now());
      const ready = () => {
        const left = new Set(this.plan(kind, this.now()).stale.map((s) => s.id));
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
   * The sessions a window counts: those last written since it began, and every running one; of
   * them, those whose buckets are not known to be current: not read yet, changed since (by their
   * `updatedAt`), running now, or running when they were read.
   */
  private plan(kind: WeekWindowKind, now: number): Plan {
    const window = weekWindow(kind, now);
    const from = window.hourStarts[0] ?? now;
    const wanted = this.store
      .weekSessions()
      .filter((s) => running(s) || !(Date.parse(s.updatedAt) < from));
    return { window, wanted, stale: staleSessions(wanted, this.cache) };
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

  /** Buckets one session read as of `asOf` (the computation's time) into the cache. */
  private async keep(s: SessionSummary, got: WeekRead, asOf: number): Promise<boolean> {
    const waits = this.waitSourceOf?.(s.id);
    const buckets = await sessionBucketsPausing(got.snapshot, asOf, yieldToLoop, waits);
    if (this.stopped) return false;
    this.cache.set(s.id, { buckets, updatedAt: s.updatedAt, readAt: asOf, running: running(s) });
    return true;
  }

  private async run(job: Job): Promise<WeekResult> {
    const started = performance.now();
    const now = this.now();
    this.prune(this.store.weekSessions(), now);
    const { window, wanted, stale } = this.plan(job.kind, now);
    const total = wanted.length;
    let done = total - stale.length;
    const emit = () => {
      job.last = { type: 'progress', done, total };
      for (const cb of job.listeners) cb(job.last);
    };
    emit();

    const reads = await readWindowSessions({
      store: this.store,
      stale,
      cache: this.cache,
      now,
      refresh: job.refresh,
      reparseMs: this.reparseMs,
      concurrency: this.concurrency,
      bigBytes: this.bigBytes,
      bigReads: this.bigReads,
      stopped: () => this.stopped,
      log: this.log,
      label: 'week',
      advance: (by) => {
        done += by;
        emit();
      },
      keep: (s, got, asOf) => this.keep(s, got, asOf),
    });
    if (this.stopped) throw new Error('stopped');

    // Every session not read again was finished when read and is listed as then: the same now.
    // So the result is as of now (R27), save a running one parsed in the last `reparseMs`.
    const sessions: WeekSession[] = [];
    for (const s of wanted) {
      const c = this.cache.get(s.id);
      if (!c) continue;
      const row = sliceSession(c.buckets, window, s.tags ?? []);
      if (!row) continue;
      if (this.repoOf && row.cwd) row.repo = this.repoOf(row.cwd);
      sessions.push(row);
    }
    sessions.sort(
      (a, b) =>
        b.inWindow.agentMs - a.inWindow.agentMs || b.inWindow.activeMs - a.inWindow.activeMs,
    );
    return {
      window,
      sessions,
      asOf: now,
      stats: {
        considered: total,
        read: reads.read,
        cached: total - reads.tried,
        failed: reads.failed,
        bytes: reads.bytes,
        ms: Math.round(performance.now() - started),
      },
    };
  }
}
