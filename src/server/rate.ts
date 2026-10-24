/**
 * Counts the token rate (`shared/rate.ts`) from the sessions' cumulative usage, as the store sees
 * it change: each observation of a session adds its growth since the last one to the current
 * minute's bucket for its agent kind.
 *
 * - The first sighting of a session is only a baseline: an old session first seen (or reopened)
 *   never reads as a spike of everything it ever spent.
 * - A total that shrinks (a rebuilt session) is a new baseline, never a negative count.
 * - While a session settles after it opens (`hold`), and in the observation that brings a file
 *   read for the first time (`absorbNext`: a sub-agent or workflow transcript classified late, a
 *   rebuild), growth is history being read, not tokens being spent: it joins the baseline.
 * - Otherwise growth counts in the minute it is observed, which is when it was written to within
 *   a second or two.
 */
import type { AgentKind, TokenUsage } from '../core/model.js';
import {
  MINUTE_MS,
  RATE_KINDS,
  RATE_MINUTES,
  type RateCoverage,
  type RateKind,
  type TokenRate,
} from '../shared/rate.js';

type Totals = Record<RateKind, number>;

const totalsOf = (u: TokenUsage): Totals => ({
  input: u.input,
  cacheRead: u.cacheRead,
  cacheWrite: u.cacheWrite,
  output: u.output,
});

const zero = (): Totals => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

const NO_COVERAGE: RateCoverage = { running: 0, counted: 0, agents: {} };

export class RateTracker {
  /** Each session's totals at its last observation. */
  private readonly seen = new Map<string, Totals>();
  /** Sessions still settling after they opened: their growth joins the baseline. */
  private readonly held = new Set<string>();
  /** Sessions whose next observation brings content read for the first time. */
  private readonly absorbing = new Set<string>();
  /** Minute index (epoch minutes) → agent kind → tokens per kind. */
  private readonly buckets = new Map<number, Map<AgentKind, Totals>>();
  private readonly since: number;

  constructor(private readonly now: () => number = Date.now) {
    this.since = now();
  }

  /**
   * One observation of a session's cumulative usage. True when it counted anything. A null
   * usage (the session is not parsed) is no observation at all.
   */
  observe(sessionId: string, agent: AgentKind, usage: TokenUsage | null): boolean {
    if (!usage) return false;
    const totals = totalsOf(usage);
    const before = this.seen.get(sessionId);
    const absorbed = this.absorbing.delete(sessionId);
    this.seen.set(sessionId, totals);
    if (!before || absorbed || this.held.has(sessionId)) return false;
    // A kind that shrank means the totals were recomputed from different data (a rebuild, a file
    // dropped), and the other kinds' growth may be part of that too: none of it is trusted.
    if (RATE_KINDS.some((k) => totals[k] < before[k])) return false;
    const minute = Math.floor(this.now() / MINUTE_MS);
    let counted = false;
    for (const k of RATE_KINDS) {
      const grew = totals[k] - before[k];
      if (grew <= 0) continue;
      const agents = this.buckets.get(minute) ?? new Map<AgentKind, Totals>();
      this.buckets.set(minute, agents);
      const bucket = agents.get(agent) ?? zero();
      agents.set(agent, bucket);
      bucket[k] += grew;
      counted = true;
    }
    if (counted) this.prune(minute);
    return counted;
  }

  /** The session is no longer watched: its next observation is a baseline again. */
  forget(sessionId: string): void {
    this.seen.delete(sessionId);
    this.held.delete(sessionId);
    this.absorbing.delete(sessionId);
  }

  /** The session is settling (just opened): count nothing of it until `release`. */
  hold(sessionId: string): void {
    this.held.add(sessionId);
  }

  release(sessionId: string): void {
    this.held.delete(sessionId);
  }

  /** The session's next observation brings content read for the first time: not spend. */
  absorbNext(sessionId: string): void {
    this.absorbing.add(sessionId);
  }

  /** Whether the session's growth counts now: seen, and not settling. */
  isCounting(sessionId: string): boolean {
    return this.seen.has(sessionId) && !this.held.has(sessionId);
  }

  snapshot(coverage: RateCoverage = NO_COVERAGE): TokenRate {
    const now = this.now();
    const minute = Math.floor(now / MINUTE_MS);
    this.prune(minute);
    const first = minute - RATE_MINUTES + 1;
    const agents: TokenRate['agents'] = {};
    for (const [m, perAgent] of this.buckets) {
      // A clock set back leaves buckets "ahead": they are not in this hour.
      if (m < first || m > minute) continue;
      for (const [agent, totals] of perAgent) {
        const series = agents[agent] ?? {
          input: new Array<number>(RATE_MINUTES).fill(0),
          cacheRead: new Array<number>(RATE_MINUTES).fill(0),
          cacheWrite: new Array<number>(RATE_MINUTES).fill(0),
          output: new Array<number>(RATE_MINUTES).fill(0),
        };
        agents[agent] = series;
        for (const k of RATE_KINDS) series[k][m - first] = totals[k];
      }
    }
    return {
      minute: new Date(minute * MINUTE_MS).toISOString(),
      at: new Date(now).toISOString(),
      since: new Date(this.since).toISOString(),
      agents,
      coverage,
    };
  }

  /** Drops buckets older than the hour that ends with `minute`. */
  private prune(minute: number): void {
    for (const m of this.buckets.keys()) if (m <= minute - RATE_MINUTES) this.buckets.delete(m);
  }
}
