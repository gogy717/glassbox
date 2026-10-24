import { idleActivity } from '../core/activity.js';
import type { AgentAdapter, SessionSource } from '../core/adapter.js';
import type {
  LiveState,
  QuotaSnapshot,
  QuotaStaleReason,
  RequestDetail,
  SessionPatch,
  SessionSnapshot,
  SessionSummary,
} from '../core/model.js';
import type { QuotaSource } from '../core/quota-source.js';
import { type RateCoverage, ratePerMinute, type TokenRate } from '../shared/rate.js';
import { Coalescer } from './coalescer.js';
import { errorText, OpenSession } from './open-session.js';
import { adapterQuotaSources, QuotaWatcher } from './quota.js';
import { RateTracker } from './rate.js';

export interface SessionStoreOptions {
  adapters: AgentAdapter[];
  /** Plan quota sources besides the adapters' own `quota()`; merged with them per provider. */
  quotaSources?: QuotaSource[];
  /** Why a stale quota is stale, when the caller can tell (see `QuotaWatcherOptions`). */
  quotaStaleReason?: (q: QuotaSnapshot) => QuotaStaleReason | undefined;
  /** Parsed sessions kept in memory; busy/waiting and subscribed ones don't count against it. */
  maxOpen?: number;
  /** How often to look for new or updated sessions on disk. */
  discoverMs?: number;
  /** How often to poll live status (and refresh watched dirs of open sessions). */
  liveMs?: number;
  /** Minimum gap between two patches of one session (protocol: ≤ 10/s). */
  patchMs?: number;
  /** Minimum gap between two session-list events (protocol: ≤ 1/s). */
  sessionsMs?: number;
  /** Stat-poll fallback interval of the file watcher. */
  pollMs?: number;
  /** Bytes read and parsed between two yields to the event loop when opening a session. */
  chunkBytes?: number;
  /** How often to re-read plan quotas (they also go stale with age). */
  quotaPollMs?: number;
  /** Minimum gap between two token-rate events. */
  rateMs?: number;
  /** How often the rate is looked at again without new spend (its average decays meanwhile). */
  rateTickMs?: number;
  /** The clock the token rate counts by. */
  now?: () => number;
  log?: (msg: string) => void;
}

type PatchListener = (patch: SessionPatch) => void;
type ResetListener = (snapshot: SessionSnapshot) => void;

interface Entry {
  adapter: AgentAdapter;
  source: SessionSource;
  /** Discovery summary, replaced by the parsed one while the session is open. */
  summary: SessionSummary;
  live: LiveState;
  open: OpenSession | null;
  opening: Promise<OpenSession> | null;
  lastUsed: number;
  /** Consecutive discoveries that did not list this session. */
  missed: number;
}

/** Discovery interval while someone waits for a session to appear (it costs a few ms). */
const QUICK_DISCOVER_MS = 200;

/** Consecutive discoveries a session must be missing from before it leaves the list. */
const MISSES_BEFORE_DROP = 2;

/** Steps of time in which a decaying rate is pushed again; a minute's turn is one of them. */
const RATE_STEP_MS = 15_000;

/**
 * What a rate event says, without the exact time it was made. While the 5-minute window holds
 * tokens its average falls as time passes with no new spend, so the 15 s step counts too: a
 * paused session's rate comes down before the minute turns.
 */
const rateKey = (r: TokenRate) =>
  JSON.stringify([
    r.minute,
    r.agents,
    r.coverage,
    ratePerMinute(r) > 0 ? Math.floor(Date.parse(r.at) / RATE_STEP_MS) : null,
  ]);

/** busy and waiting both mean someone is mid-task in that session right now. */
export function isActive(live: LiveState): boolean {
  return live === 'busy' || live === 'waiting';
}

/**
 * The summary under the latest polled live state. An open session's parser hears of a change
 * at once but may send its next summary up to a patch gap later: its activity was worked out
 * for the old state, so it goes until then. Idle sessions are not opened in the background;
 * their activity needs nothing a parser knows: idle since the last write.
 */
export function listedSummary(summary: SessionSummary, live = summary.live): SessionSummary {
  let next = summary;
  if (summary.live !== live) {
    const { activity: _stale, ...rest } = summary;
    next = { ...rest, live };
  }
  if (live !== 'idle' || next.activity) return next;
  return { ...next, activity: idleActivity(next.updatedAt) };
}

export function compareSessions(a: SessionSummary, b: SessionSummary): number {
  return (
    Number(isActive(b.live)) - Number(isActive(a.live)) ||
    (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Every session the adapters know about, plus parsers for the ones somebody looked at.
 *
 * Discovery and live status are polled; open sessions are kept current by their watchers
 * and pushed to subscribers as batched patches.
 */
export class SessionStore {
  private readonly opts: Required<SessionStoreOptions>;
  private readonly entries = new Map<string, Entry>();
  private readonly sessionListeners = new Set<(s: SessionSummary[]) => void>();
  private readonly patchListeners = new Map<string, Set<PatchListener>>();
  private readonly resetListeners = new Map<string, Set<ResetListener>>();
  private discoverTimer: NodeJS.Timeout | null = null;
  private liveTimer: NodeJS.Timeout | null = null;
  private readonly sessionsPacer: Coalescer;
  private lastSessionsJson = '';
  private stopped = false;
  private useCounter = 0;
  private autoOpenQueued = false;
  private autoOpening = false;
  /** expectSession callers, by session id. */
  private readonly expecting = new Map<string, Set<(found: boolean) => void>>();
  private quickDiscoverTimer: NodeJS.Timeout | null = null;
  private discovering: Promise<void> | null = null;
  private readonly quota: QuotaWatcher;
  private readonly rate: RateTracker;
  private readonly rateListeners = new Set<(r: TokenRate) => void>();
  private readonly ratePacer: Coalescer;
  /** The last rate sent, without its timestamp: unchanged windows are not sent again. */
  private lastRateKey = '';
  private rateTimer: NodeJS.Timeout | null = null;
  /** Sessions settling after they opened, and when the rate may count them. */
  private readonly settling = new Map<string, number>();

  constructor(opts: SessionStoreOptions) {
    this.opts = {
      maxOpen: 8,
      discoverMs: 5000,
      liveMs: 1000,
      patchMs: 100,
      sessionsMs: 1000,
      pollMs: 1000,
      chunkBytes: 4 * 1024 * 1024,
      quotaPollMs: 30_000,
      rateMs: 5000,
      rateTickMs: RATE_STEP_MS,
      now: Date.now,
      quotaSources: [],
      quotaStaleReason: () => undefined,
      log: () => {},
      ...opts,
    };
    this.sessionsPacer = new Coalescer(this.opts.sessionsMs, () => this.emitSessions());
    this.rate = new RateTracker(this.opts.now);
    this.ratePacer = new Coalescer(this.opts.rateMs, () => this.emitRate());
    this.quota = new QuotaWatcher({
      sources: [...adapterQuotaSources(this.opts.adapters), ...this.opts.quotaSources],
      pollMs: this.opts.quotaPollMs,
      staleReason: this.opts.quotaStaleReason,
      log: this.opts.log,
    });
  }

  async start(): Promise<void> {
    await this.discoverNow();
    await this.refreshLive();
    await this.quota.start();
    this.lastSessionsJson = JSON.stringify(this.listSessions());
    this.loop('discoverTimer', this.opts.discoverMs, () => this.discoverNow());
    this.loop('liveTimer', this.opts.liveMs, () => this.refreshLive());
    this.lastRateKey = rateKey(this.getRate());
    this.scheduleRateTick();
    this.scheduleAutoOpen();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.quickDiscoverTimer) clearTimeout(this.quickDiscoverTimer);
    this.quickDiscoverTimer = null;
    for (const set of [...this.expecting.values()]) for (const done of [...set]) done(false);
    this.sessionsPacer.cancel();
    this.ratePacer.cancel();
    for (const t of [this.discoverTimer, this.liveTimer, this.rateTimer]) if (t) clearTimeout(t);
    this.discoverTimer = this.liveTimer = this.rateTimer = null;
    for (const entry of this.entries.values()) this.closeEntry(entry);
    this.quota.stop();
    this.sessionListeners.clear();
    this.patchListeners.clear();
    this.resetListeners.clear();
    this.rateListeners.clear();
  }

  /** Tokens per minute bucket over the last hour, by agent and token kind. */
  getRate(): TokenRate {
    return this.rate.snapshot(this.coverage());
  }

  /** Which running sessions the rate is counting: the open, settled ones. */
  private coverage(): RateCoverage {
    const c: RateCoverage = { running: 0, counted: 0, agents: {} };
    for (const e of this.entries.values()) {
      if (!isActive(e.live)) continue;
      const agent = c.agents[e.summary.agent] ?? { running: 0, counted: 0 };
      c.agents[e.summary.agent] = agent;
      const counted = e.open !== null && this.rate.isCounting(e.summary.id) ? 1 : 0;
      c.running++;
      agent.running++;
      c.counted += counted;
      agent.counted += counted;
    }
    return c;
  }

  /** Called when the rate's window changes, at most once per `rateMs`. */
  onRate(cb: (r: TokenRate) => void): () => void {
    this.rateListeners.add(cb);
    return () => this.rateListeners.delete(cb);
  }

  listSessions(): SessionSummary[] {
    return [...this.entries.values()]
      .map((e) => listedSummary(e.summary, e.live))
      .sort(compareSessions);
  }

  async getSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    const open = await this.openById(sessionId);
    return open ? open.parser.snapshot() : null;
  }

  async getRequestDetail(sessionId: string, requestId: string): Promise<RequestDetail | null> {
    const open = await this.openById(sessionId);
    return open ? open.parser.requestDetail(requestId) : null;
  }

  async getToolResult(
    sessionId: string,
    toolCallId: string,
  ): Promise<{ found: boolean; result: unknown }> {
    const open = await this.openById(sessionId);
    const result = open ? open.parser.toolResult(toolCallId) : undefined;
    return { found: result !== undefined, result };
  }

  listQuotas(): QuotaSnapshot[] {
    return this.quota.current();
  }

  onQuota(cb: (q: QuotaSnapshot[]) => void): () => void {
    return this.quota.onChange(cb);
  }

  /**
   * Resolves true as soon as discovery knows `sessionId` — a session that is just being
   * created, e.g. by a run started from the UI — and false after `timeoutMs`. While anyone
   * waits, discovery runs every `QUICK_DISCOVER_MS` instead of every `discoverMs`.
   */
  expectSession(sessionId: string, timeoutMs = 30_000): Promise<boolean> {
    if (this.entries.has(sessionId)) return Promise.resolve(true);
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const set = this.expecting.get(sessionId) ?? new Set();
      this.expecting.set(sessionId, set);
      const done = (found: boolean) => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.expecting.delete(sessionId);
        if (this.expecting.size === 0 && this.quickDiscoverTimer) {
          clearTimeout(this.quickDiscoverTimer);
          this.quickDiscoverTimer = null;
        }
        resolve(found);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      set.add(done);
      void this.quickDiscover();
    });
  }

  onSessions(cb: (s: SessionSummary[]) => void): () => void {
    this.sessionListeners.add(cb);
    return () => {
      this.sessionListeners.delete(cb);
    };
  }

  /**
   * Patches of one session. `onReset` receives a full snapshot whenever the session is
   * rebuilt from scratch (a file was truncated or replaced): patches can't remove entities,
   * so subscribers must replace their state. A session with subscribers is never evicted.
   */
  onPatch(sessionId: string, cb: PatchListener, onReset?: ResetListener): () => void {
    const add = <T>(map: Map<string, Set<T>>, item: T) => {
      const set = map.get(sessionId) ?? new Set<T>();
      map.set(sessionId, set);
      set.add(item);
    };
    const remove = <T>(map: Map<string, Set<T>>, item: T) => {
      const set = map.get(sessionId);
      set?.delete(item);
      if (set?.size === 0) map.delete(sessionId);
    };
    add(this.patchListeners, cb);
    if (onReset) add(this.resetListeners, onReset);
    return () => {
      remove(this.patchListeners, cb);
      if (onReset) remove(this.resetListeners, onReset);
    };
  }

  // ── Opening and eviction ──────────────────────────────────────────────────────────────

  private async openById(sessionId: string): Promise<OpenSession | null> {
    const entry = this.entries.get(sessionId);
    if (!entry || this.stopped) return null;
    entry.lastUsed = ++this.useCounter;
    if (entry.open) return entry.open;
    if (!entry.opening) {
      entry.opening = this.openEntry(entry).finally(() => {
        entry.opening = null;
      });
    }
    return entry.opening;
  }

  private async openEntry(entry: Entry): Promise<OpenSession> {
    const id = entry.summary.id;
    // Its first summary is a baseline for the token rate, and it counts nothing while it settles:
    // what it spent before is not now.
    this.rate.forget(id);
    this.rate.hold(id);
    const session = new OpenSession(entry.adapter, entry.source, {
      patchMs: this.opts.patchMs,
      pollMs: this.opts.pollMs,
      chunkBytes: this.opts.chunkBytes,
      live: entry.live,
      log: this.opts.log,
      onBackfill: () => this.rate.absorbNext(id),
      onSummary: (summary) => {
        if (entry.open !== session && entry.opening === null) return;
        entry.summary = summary;
        if (this.rate.observe(id, summary.agent, summary.usage)) this.notifyRate();
        this.notifySessions();
      },
      onPatch: (patch) => {
        for (const cb of this.patchListeners.get(id) ?? []) cb(patch);
      },
      onReset: (snapshot) => {
        for (const cb of this.resetListeners.get(id) ?? []) cb(snapshot);
      },
    });
    try {
      await session.load();
    } catch (err) {
      session.close();
      throw err;
    }
    // Loaded: the rate counts it from the first live tick after one has passed quietly.
    this.settling.set(id, this.opts.now() + this.opts.liveMs);
    // Stopped, or the entry was dropped while we read: nothing would ever close it.
    if (this.stopped || this.entries.get(id) !== entry) {
      session.close();
      return session;
    }
    entry.open = session;
    // The live poll may have moved on while it loaded, with no open session to tell.
    session.setLive(entry.live);
    this.evict(entry);
    return session;
  }

  private evict(keep: Entry): void {
    const open = [...this.entries.values()].filter((e) => e.open);
    let excess = open.length - this.opts.maxOpen;
    if (excess <= 0) return;
    const candidates = open
      .filter((e) => e !== keep && !isActive(e.live) && !this.patchListeners.has(e.summary.id))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of candidates) {
      if (excess-- <= 0) break;
      this.closeEntry(entry);
    }
  }

  private closeEntry(entry: Entry): void {
    entry.open?.close();
    entry.open = null;
    this.rate.forget(entry.summary.id);
    this.settling.delete(entry.summary.id);
  }

  // ── Polling ───────────────────────────────────────────────────────────────────────────

  private loop(timer: 'discoverTimer' | 'liveTimer', ms: number, task: () => Promise<void>): void {
    const tick = async () => {
      try {
        await task();
      } catch (err) {
        this.opts.log(
          `${timer === 'liveTimer' ? 'live status' : 'discovery'} poll failed: ${errorText(err)}`,
        );
      }
      if (!this.stopped) this[timer] = setTimeout(tick, ms);
    };
    this[timer] = setTimeout(tick, ms);
  }

  private async refreshDiscovery(): Promise<void> {
    for (const adapter of this.opts.adapters) {
      let sources: SessionSource[];
      try {
        sources = await adapter.discover();
      } catch (err) {
        this.opts.log(`discover (${adapter.kind}) failed: ${errorText(err)}`);
        continue;
      }
      if (this.stopped) return;
      const seen = new Set<string>();
      for (const source of sources) {
        const id = source.summary.id;
        seen.add(id);
        const entry = this.entries.get(id);
        if (!entry) {
          this.entries.set(id, {
            adapter,
            source,
            summary: source.summary,
            live: source.summary.live,
            open: null,
            opening: null,
            lastUsed: 0,
            missed: 0,
          });
        } else {
          entry.missed = 0;
          if (!entry.open && !entry.opening) {
            // Open sessions keep their parsed summary; the parser is more current.
            entry.source = source;
            entry.summary = source.summary;
          }
        }
      }
      for (const [id, entry] of this.entries) {
        if (entry.adapter !== adapter || seen.has(id)) continue;
        // Gone from disk — or a directory read failed this once. Keep sessions someone is
        // watching or opening, and only believe a disappearance that repeats.
        if (this.patchListeners.has(id) || entry.opening) continue;
        if (++entry.missed < MISSES_BEFORE_DROP) continue;
        this.closeEntry(entry);
        this.entries.delete(id);
      }
    }
    for (const [id, set] of [...this.expecting]) {
      if (this.entries.has(id)) for (const done of [...set]) done(true);
    }
    this.notifySessions();
    this.scheduleAutoOpen();
  }

  private async refreshLive(): Promise<void> {
    for (const adapter of this.opts.adapters) {
      let states: Map<string, LiveState>;
      try {
        states = await adapter.liveStatus();
      } catch (err) {
        this.opts.log(`live status (${adapter.kind}) failed: ${errorText(err)}`);
        continue;
      }
      if (this.stopped) return;
      for (const entry of this.entries.values()) {
        if (entry.adapter !== adapter) continue;
        const live = states.get(entry.source.nativeId) ?? 'closed';
        const until = this.settling.get(entry.summary.id);
        if (until !== undefined && until <= this.opts.now()) {
          this.settling.delete(entry.summary.id);
          this.rate.release(entry.summary.id);
        }
        if (live !== entry.live) {
          entry.live = live;
          entry.open?.setLive(live);
        }
        try {
          entry.open?.refreshWatchDirs();
        } catch (err) {
          this.opts.log(`session ${entry.summary.id}: watch dirs failed: ${errorText(err)}`);
        }
      }
    }
    this.notifySessions();
    // Running sessions come and go, and settled ones start counting: the coverage moves.
    this.notifyRate();
    this.scheduleAutoOpen();
  }

  /** One discovery at a time: the timer loop and expectSession share it. */
  private discoverNow(): Promise<void> {
    this.discovering ??= this.refreshDiscovery().finally(() => {
      this.discovering = null;
    });
    return this.discovering;
  }

  /** Discover now, then again every QUICK_DISCOVER_MS while expectSession has waiters. */
  private async quickDiscover(): Promise<void> {
    if (this.quickDiscoverTimer) return;
    try {
      await this.discoverNow();
    } catch (err) {
      this.opts.log(`discovery failed: ${errorText(err)}`);
    }
    if (this.stopped || this.expecting.size === 0 || this.quickDiscoverTimer) return;
    this.quickDiscoverTimer = setTimeout(() => {
      this.quickDiscoverTimer = null;
      void this.quickDiscover();
    }, QUICK_DISCOVER_MS);
  }

  /**
   * Running sessions are what people watch, so their list rows should show live token totals
   * without anyone opening them first: open the most recently updated busy/waiting sessions
   * (up to `maxOpen`) in the background, one at a time, never holding up a request.
   */
  private scheduleAutoOpen(): void {
    if (this.stopped || this.autoOpenQueued) return;
    this.autoOpenQueued = true;
    setImmediate(() => {
      this.autoOpenQueued = false;
      void this.autoOpen();
    });
  }

  private async autoOpen(): Promise<void> {
    if (this.autoOpening) return;
    this.autoOpening = true;
    const failed = new Set<Entry>();
    try {
      while (!this.stopped) {
        const wanted = [...this.entries.values()]
          .filter((e) => isActive(e.live))
          .sort((a, b) => (a.summary.updatedAt < b.summary.updatedAt ? 1 : -1))
          .slice(0, this.opts.maxOpen);
        const next = wanted.find((e) => !e.open && !e.opening && !failed.has(e));
        if (!next) break;
        try {
          await this.openById(next.summary.id);
        } catch (err) {
          failed.add(next);
          this.opts.log(`auto-open ${next.summary.id} failed: ${errorText(err)}`);
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      this.autoOpening = false;
    }
  }

  /**
   * On each step of time (each 15 s, the minute's turn among them) the rate is looked at again,
   * whether or not tokens moved: the window moves at the turn, and its average decays between.
   * It is pushed only when what it says changed (`rateKey`).
   */
  private scheduleRateTick(): void {
    const step = this.opts.rateTickMs;
    this.rateTimer = setTimeout(
      () => {
        if (this.stopped) return;
        this.notifyRate();
        this.scheduleRateTick();
      },
      step - (this.opts.now() % step) + 20,
    );
  }

  private notifyRate(): void {
    if (!this.stopped) this.ratePacer.request();
  }

  private emitRate(): void {
    if (this.stopped) return;
    const rate = this.getRate();
    const key = rateKey(rate);
    if (key === this.lastRateKey) return;
    this.lastRateKey = key;
    for (const cb of this.rateListeners) cb(rate);
  }

  /** Emit the list if it changed, at most once per `sessionsMs`. */
  private notifySessions(): void {
    if (!this.stopped) this.sessionsPacer.request();
  }

  private emitSessions(): void {
    if (this.stopped) return;
    const list = this.listSessions();
    const json = JSON.stringify(list);
    if (json === this.lastSessionsJson) return;
    this.lastSessionsJson = json;
    for (const cb of this.sessionListeners) cb(list);
  }
}
