import type { AgentAdapter, SessionSource } from '../core/adapter.js';
import type {
  LiveState,
  QuotaSnapshot,
  RequestDetail,
  SessionPatch,
  SessionSnapshot,
  SessionSummary,
} from '../core/model.js';
import { Coalescer } from './coalescer.js';
import { errorText, OpenSession } from './open-session.js';
import { QuotaWatcher } from './quota.js';

export interface SessionStoreOptions {
  adapters: AgentAdapter[];
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

/** busy and waiting both mean someone is mid-task in that session right now. */
export function isActive(live: LiveState): boolean {
  return live === 'busy' || live === 'waiting';
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
      log: () => {},
      ...opts,
    };
    this.sessionsPacer = new Coalescer(this.opts.sessionsMs, () => this.emitSessions());
    this.quota = new QuotaWatcher({
      adapters: this.opts.adapters,
      pollMs: this.opts.quotaPollMs,
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
    this.scheduleAutoOpen();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.quickDiscoverTimer) clearTimeout(this.quickDiscoverTimer);
    this.quickDiscoverTimer = null;
    for (const set of [...this.expecting.values()]) for (const done of [...set]) done(false);
    this.sessionsPacer.cancel();
    for (const t of [this.discoverTimer, this.liveTimer]) if (t) clearTimeout(t);
    this.discoverTimer = this.liveTimer = null;
    for (const entry of this.entries.values()) this.closeEntry(entry);
    this.quota.stop();
    this.sessionListeners.clear();
    this.patchListeners.clear();
    this.resetListeners.clear();
  }

  listSessions(): SessionSummary[] {
    return [...this.entries.values()]
      .map((e) => (e.summary.live === e.live ? e.summary : { ...e.summary, live: e.live }))
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
    const session = new OpenSession(entry.adapter, entry.source, {
      patchMs: this.opts.patchMs,
      pollMs: this.opts.pollMs,
      chunkBytes: this.opts.chunkBytes,
      live: entry.live,
      log: this.opts.log,
      onSummary: (summary) => {
        if (entry.open !== session && entry.opening === null) return;
        entry.summary = summary;
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
    // Stopped, or the entry was dropped while we read: nothing would ever close it.
    if (this.stopped || this.entries.get(id) !== entry) {
      session.close();
      return session;
    }
    entry.open = session;
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
