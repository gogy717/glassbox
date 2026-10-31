/**
 * Who used the plan window (`GET /api/quota/burn`, contract in `src/shared/quota-burn.ts`): the
 * sessions with requests to a provider since a window began, from the sessions the week reads.
 *
 * It reads through the week's store (`WeekStore`): the same sessions, read the same way. The
 * week's own figures are by the hour and for a week, and a plan window starts at any minute, so
 * each session is kept here as what the list needs of it, small: each request's start, provider
 * and usage. A session last written before the window began is not read, unless it is running;
 * a finished one is read once and kept until it changes; a running one is read again, from memory
 * when it is open, else no sooner than `reparseMs` after its last read.
 */
import type { QuotaProvider, SessionSnapshot, SessionSummary, TokenUsage } from '../core/model.js';
import { addUsage, emptyUsage } from '../core/usage.js';
import {
  type BurnSession,
  burnTokens,
  mayUse,
  type QuotaBurn,
  requestProvider,
} from '../shared/quota-burn.js';
import { isActive } from './live.js';
import type { WeekStore } from './week.js';

export interface QuotaBurnOptions {
  /** A running session that has to be parsed is parsed again no sooner than this (ms). */
  reparseMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** What the list keeps of one request. */
interface Seen {
  /** When it started (epoch ms). */
  at: number;
  provider: QuotaProvider | null;
  usage: TokenUsage | null;
}

interface Cached {
  /** The listed `updatedAt` it was read at. */
  updatedAt: string;
  readAt: number;
  running: boolean;
  requests: Seen[];
}

/** Kept this long after a finished session was last written: past the longest window, a month. */
const KEEP_MS = 32 * 24 * 3_600_000;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const running = (s: SessionSummary) => isActive(s.live);
const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

/** Each request's start (else its end, else its turn's start), provider and usage. */
function seenOf(snap: SessionSnapshot): Seen[] {
  const turnStart = new Map(snap.turns.map((t) => [t.id, time(t.startedAt)]));
  const agent = snap.session.agent;
  return snap.requests.flatMap((r) => {
    const at =
      time(r.startedAt) ?? time(r.endedAt) ?? (r.turnId ? turnStart.get(r.turnId) : null) ?? null;
    return at === null ? [] : [{ at, provider: requestProvider(agent, r.model), usage: r.usage }];
  });
}

export class QuotaBurnService {
  private readonly cache = new Map<string, Cached>();
  /** Reads under way, so two requests at once read a session once. */
  private readonly reading = new Map<string, Promise<void>>();
  private readonly reparseMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly store: WeekStore,
    opts: QuotaBurnOptions = {},
  ) {
    this.reparseMs = opts.reparseMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** The sessions that used `provider` since `since` (epoch ms), most tokens first. */
  async compute(provider: QuotaProvider, since: number): Promise<QuotaBurn> {
    const now = this.now();
    const listed = this.store.weekSessions();
    this.prune(listed, now);
    const wanted = listed.filter(
      (s) => mayUse(s.agent, provider) && (running(s) || !(Date.parse(s.updatedAt) < since)),
    );
    for (const s of wanted) {
      if (!(await this.isCurrent(s, now))) {
        await this.read(s, now);
        await yieldToLoop();
      }
    }

    const sessions: BurnSession[] = [];
    let total = 0;
    for (const s of wanted) {
      const c = this.cache.get(s.id);
      if (!c) continue;
      const usage = emptyUsage();
      let requests = 0;
      for (const r of c.requests) {
        if (r.provider !== provider || r.at < since || r.at > now) continue;
        requests++;
        if (r.usage) addUsage(usage, r.usage);
      }
      if (requests === 0) continue;
      const tokens = burnTokens(usage);
      total += tokens;
      sessions.push({
        id: s.id,
        agent: s.agent,
        project: s.project,
        cwd: s.cwd,
        ...(s.repo !== undefined ? { repo: s.repo } : {}),
        title: s.title,
        usage,
        requests,
        tokens,
        share: 0,
      });
    }
    // No tokens reported at all: the shares are of the requests (see `QuotaBurn.counted`).
    const counted = total > 0 || sessions.length === 0 ? 'tokens' : 'requests';
    const all = sessions.reduce((n, s) => n + s.requests, 0);
    for (const s of sessions) s.share = counted === 'tokens' ? s.tokens / total : s.requests / all;
    sessions.sort(
      (a, b) => b.tokens - a.tokens || b.requests - a.requests || (a.id < b.id ? -1 : 1),
    );
    return { provider, since, asOf: now, sessions, tokens: total, counted };
  }

  /** Whether what is kept of `s` is as it is now: read since it changed, and not due again. */
  private async isCurrent(s: SessionSummary, now: number): Promise<boolean> {
    const c = this.cache.get(s.id);
    if (!c || c.updatedAt !== s.updatedAt) return false;
    if (!running(s) && !c.running) return true;
    // Running: an open session reads from memory (nothing to go through), so read it again.
    const size = this.store.sizeOf ? await this.store.sizeOf(s.id).catch(() => 0) : 1;
    return size > 0 && now - c.readAt < this.reparseMs;
  }

  private read(s: SessionSummary, now: number): Promise<void> {
    const under = this.reading.get(s.id);
    if (under) return under;
    const job = (async () => {
      try {
        const got = await this.store.readSession(s.id);
        if (!got) return;
        this.cache.set(s.id, {
          updatedAt: s.updatedAt,
          readAt: now,
          running: running(s),
          requests: seenOf(got.snapshot),
        });
      } catch (err) {
        this.log(`quota burn: could not read ${s.id}: ${err instanceof Error ? err.message : err}`);
      }
    })().finally(() => this.reading.delete(s.id));
    this.reading.set(s.id, job);
    return job;
  }

  /** Forgets sessions no longer listed, and finished ones last written before any window. */
  private prune(listed: SessionSummary[], now: number): void {
    const keep = new Set(
      listed
        .filter((s) => running(s) || !(Date.parse(s.updatedAt) < now - KEEP_MS))
        .map((s) => s.id),
    );
    for (const id of this.cache.keys()) if (!keep.has(id)) this.cache.delete(id);
  }
}
