/**
 * The Rules page's data (`GET /api/rules`, contract in `src/shared/permissions.ts`): every session
 * of the window read once and kept, in memory only, as its permission events; each request counts
 * them by rule, and reads the settings again (a rule just pasted shows at the next request).
 *
 * The reading is the week's (`week.ts`, whose comments say why): two sessions at a time with a
 * yield between them, the smallest first and one very large session at a time, a running one
 * parsed again no sooner than `reparseMs` unless a refresh asks; and one computation at a time: a
 * request for the window being read joins it, progress and all, any other waits its turn,
 * hearing meanwhile how many of its sessions are ready. Only the agents that have rules are read.
 */
import type { RepoIdentity, SessionSummary } from '../core/model.js';
import {
  type PermissionEvent,
  permissionEvents,
  type RuleProject,
  type RulesResult,
  type RulesWindowKind,
  ruleRows,
  rulesWindowStart,
  type SessionEvents,
  type SettingsFile,
} from '../shared/permissions.js';
import { isActive } from './live.js';
import { steady, type WeekProgress, type WeekStore } from './week.js';

export interface RulesOptions {
  /**
   * The permission lists of the settings files of these projects, and yours
   * (`readRuleSettings`); none when absent.
   */
  readSettings?: (projects: { root: string; dirs: string[] }[]) => Promise<SettingsFile[]>;
  /** Where your own settings file is (`<claudeDir>/settings.json`), there or not. */
  yourSettings?: string;
  /** The answers glassbox runs keep (`runDecisions`), asked at each read; none when absent. */
  decisions?: () => ReadonlyMap<string, 'allow' | 'deny'>;
  /** The home directory, for keys of files under it (`~/…`). */
  home?: string | null;
  /** Sessions read at once. */
  concurrency?: number;
  /** A session this large (bytes) is read alone. */
  bigBytes?: number;
  /** A running session that has to be parsed is parsed again no sooner than this (ms). */
  reparseMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Agents whose calls have permission rules glassbox can read. */
const WITH_RULES = new Set(['claude-code', 'codex']);

interface Cached {
  events: PermissionEvent[];
  project: RuleProject;
  /** The working tree the session ran in, whose own settings count for its project. */
  tree: string | null;
  updatedAt: string;
  readAt: number;
  running: boolean;
}

interface Job {
  kind: RulesWindowKind;
  refresh: boolean;
  promise: Promise<RulesResult>;
  listeners: Set<(p: WeekProgress) => void>;
  last: WeekProgress;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

const running = (s: SessionSummary) => isActive(s.live);

/** The session's repository as listed; a session without one is in its own directory. */
function placeOf(s: SessionSummary): { project: RuleProject; tree: string | null } {
  const repo: RepoIdentity | null = s.repo ?? null;
  if (repo) return { project: { root: repo.root, name: repo.name }, tree: repo.dir };
  return { project: { root: s.cwd, name: s.project }, tree: s.cwd };
}

export class RulesService {
  private readonly cache = new Map<string, Cached>();
  private job: Job | null = null;
  private stopped = false;
  private bigRead: Promise<void> = Promise.resolve();
  private readonly concurrency: number;
  private readonly bigBytes: number;
  private readonly reparseMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly store: WeekStore,
    private readonly opts: RulesOptions = {},
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.bigBytes = opts.bigBytes ?? 64 * 1024 * 1024;
    this.reparseMs = opts.reparseMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** No more reading: a computation under way ends at its next session, and none starts. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * The window's rules. `onProgress` hears where the reading is at once, then after each session
   * read; `done` never goes down.
   */
  async compute(
    kind: RulesWindowKind,
    opts: { refresh?: boolean } = {},
    onProgress?: (p: WeekProgress) => void,
  ): Promise<RulesResult> {
    const refresh = opts.refresh === true;
    const hear = steady(onProgress);
    for (;;) {
      if (this.stopped) throw new Error('stopped');
      const current = this.job;
      if (!current) break;
      if (current.kind === kind && (current.refresh || !refresh)) return this.join(current, hear);
      const plan = this.plan(kind, this.now());
      const tell = () => {
        const left = new Set(this.plan(kind, this.now()).stale.map((s) => s.id));
        const ready = plan.wanted.filter((s) => !left.has(s.id)).length;
        hear?.({ type: 'progress', done: ready, total: plan.wanted.length });
      };
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

  private start(kind: RulesWindowKind, refresh: boolean): Job {
    const job: Job = {
      kind,
      refresh,
      listeners: new Set(),
      last: { type: 'progress', done: 0, total: 0 },
      promise: Promise.resolve() as unknown as Promise<RulesResult>,
    };
    this.job = job;
    job.promise = this.run(job).finally(() => {
      if (this.job === job) this.job = null;
    });
    return job;
  }

  private async join(job: Job, onProgress?: (p: WeekProgress) => void): Promise<RulesResult> {
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
   * The sessions a window counts: those of an agent with rules last written since it began, and
   * every running one; of them, those not known to be as cached.
   */
  private plan(kind: RulesWindowKind, now: number) {
    const from = rulesWindowStart(kind, now);
    const wanted = this.store
      .weekSessions()
      .filter(
        (s) =>
          WITH_RULES.has(s.agent) &&
          (running(s) || from === null || !(Date.parse(s.updatedAt) < from)),
      );
    const stale = wanted.filter((s) => {
      const c = this.cache.get(s.id);
      return !c || running(s) || c.running || c.updatedAt !== s.updatedAt;
    });
    return { from, wanted, stale };
  }

  /** Reads one session into the cache; its bytes, or null when it was not read. */
  private async read(s: SessionSummary, size: number, asOf: number): Promise<number | null> {
    const big = size >= this.bigBytes;
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
      const { project, tree } = placeOf(s);
      const events = permissionEvents(
        got.snapshot,
        { cwd: s.cwd, tree, home: this.opts.home ?? null },
        this.opts.decisions?.(),
      );
      this.cache.set(s.id, {
        events,
        project,
        tree,
        updatedAt: s.updatedAt,
        readAt: asOf,
        running: running(s),
      });
      return got.bytes;
    } finally {
      release();
    }
  }

  private async run(job: Job): Promise<RulesResult> {
    const started = performance.now();
    const now = this.now();
    const listed = new Set(this.store.weekSessions().map((s) => s.id));
    for (const id of this.cache.keys()) if (!listed.has(id)) this.cache.delete(id);
    const { from, wanted, stale } = this.plan(job.kind, now);
    const total = wanted.length;
    let done = total - stale.length;
    const emit = () => {
      job.last = { type: 'progress', done, total };
      for (const cb of job.listeners) cb(job.last);
    };
    emit();

    const sizeOf = this.store.sizeOf?.bind(this.store);
    const sized = await Promise.all(
      stale.map(async (s) => ({ s, size: sizeOf ? await sizeOf(s.id).catch(() => 0) : 0 })),
    );
    const toRead = sized.filter(({ s, size }) => {
      const c = this.cache.get(s.id);
      return !c || job.refresh || size === 0 || !(running(s) && now - c.readAt < this.reparseMs);
    });
    if (toRead.length < sized.length) {
      done += sized.length - toRead.length;
      emit();
    }
    toRead.sort((a, b) => a.size - b.size);

    let read = 0;
    let failed = 0;
    let next = 0;
    const worker = async () => {
      for (let item = toRead[next++]; item && !this.stopped; item = toRead[next++]) {
        try {
          if ((await this.read(item.s, item.size, now)) === null) failed++;
          else read++;
        } catch (err) {
          failed++;
          this.log(
            `rules: could not read ${item.s.id}: ${err instanceof Error ? err.message : err}`,
          );
        }
        done++;
        emit();
        await yieldToLoop();
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, toRead.length) }, worker));
    if (this.stopped) throw new Error('stopped');

    const sessions: SessionEvents[] = [];
    const dirs = new Map<string, Set<string>>();
    for (const s of wanted) {
      const c = this.cache.get(s.id);
      if (!c) continue;
      sessions.push({ sessionId: s.id, project: c.project, events: c.events });
      const asked = c.events.some((e) => from === null || !(Date.parse(e.at) < from));
      const { root } = c.project;
      if (!asked || root === null) continue;
      const set = dirs.get(root) ?? new Set([root]);
      if (c.tree) set.add(c.tree);
      dirs.set(root, set);
    }
    let settings: SettingsFile[] = [];
    try {
      settings =
        (await this.opts.readSettings?.(
          [...dirs].map(([root, set]) => ({ root, dirs: [...set] })),
        )) ?? [];
    } catch (err) {
      this.log(`rules: could not read the settings: ${err instanceof Error ? err.message : err}`);
    }
    return {
      window: { kind: job.kind, from, now },
      rows: ruleRows(sessions, { from, settings }),
      settings,
      yourSettings: this.opts.yourSettings ?? null,
      asOf: now,
      stats: {
        considered: total,
        read,
        cached: total - toRead.length,
        failed,
        ms: Math.round(performance.now() - started),
      },
    };
  }
}
