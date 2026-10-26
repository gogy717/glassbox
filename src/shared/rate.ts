/**
 * Token rate: how fast the agents on this machine are spending tokens, per agent kind and token
 * kind, in 1-minute buckets over the last hour. The server counts it from the sessions' usage
 * totals (`server/rate.ts`); the UI averages and charts it with the helpers below. Tokens are
 * counted as the sidebar's session totals are: uncached input + cache reads + cache writes +
 * output, sub-agents included.
 */
import type { AgentKind, IsoTime } from '../core/model.js';

export const RATE_KINDS = ['input', 'cacheRead', 'cacheWrite', 'output'] as const;
export type RateKind = (typeof RATE_KINDS)[number];

/** Minutes of history, and so the length of every series. */
export const RATE_MINUTES = 60;
export const MINUTE_MS = 60_000;

/**
 * How much of the running work the rate sees. Only sessions the server has open are counted: it
 * opens running ones in the background, but at most a few at a time, and a session counts only
 * once its load has settled. A running session not counted adds nothing to the rate.
 */
export interface RateCoverage {
  /** Sessions busy or waiting for the person right now. */
  running: number;
  /** Of those, the ones being counted. */
  counted: number;
  agents: Partial<Record<AgentKind, AgentCoverage>>;
}

export interface AgentCoverage {
  running: number;
  counted: number;
  /**
   * 'turn' when the agent reports a turn's tokens only as it ends: its line fills in then,
   * spread over the turn's minutes, and shows nothing while a turn runs. Absent: per model call.
   */
  reporting?: 'turn';
}

export interface TokenRate {
  /** Start of the newest bucket: the minute in progress when this was made. */
  minute: IsoTime;
  /** When this was made, by the server's clock; the newest bucket covers `minute`..`at`. */
  at: IsoTime;
  /** When counting began: buckets before it are unknown, not idle. */
  since: IsoTime;
  /**
   * Tokens counted per bucket, oldest first, `RATE_MINUTES` long and ending with `minute`, per
   * agent kind and token kind. An agent with nothing counted in the hour is absent.
   */
  agents: Partial<Record<AgentKind, Record<RateKind, number[]>>>;
  coverage: RateCoverage;
}

export interface RateScope {
  /** One agent kind; null or absent: all of them. */
  agent?: AgentKind | null;
  /** One token kind; null or absent: all of them. */
  kind?: RateKind | null;
}

/** Tokens per bucket in a scope, oldest first. */
export function rateSeries(rate: TokenRate, scope: RateScope = {}): number[] {
  const out = new Array<number>(RATE_MINUTES).fill(0);
  for (const [agent, kinds] of Object.entries(rate.agents)) {
    if (!kinds || (scope.agent != null && agent !== scope.agent)) continue;
    for (const kind of RATE_KINDS) {
      if (scope.kind != null && kind !== scope.kind) continue;
      kinds[kind].forEach((n, i) => {
        out[i] = (out[i] ?? 0) + n;
      });
    }
  }
  return out;
}

/**
 * Tokens per minute over the last `minutes` buckets, the newest one partial: the tokens counted
 * in them over the time they cover, from the oldest bucket's start (or `since`, if later) to
 * `at`. At least one minute, so a burst in the first seconds does not read as a huge rate.
 */
export function ratePerMinute(rate: TokenRate, scope: RateScope = {}, minutes = 5): number {
  const series = rateSeries(rate, scope);
  const tokens = series.slice(-minutes).reduce((a, b) => a + b, 0);
  const at = Date.parse(rate.at);
  const oldest = Date.parse(rate.minute) - (minutes - 1) * MINUTE_MS;
  const span = (at - Math.max(oldest, Date.parse(rate.since))) / MINUTE_MS;
  return tokens / Math.max(1, span);
}

/** Tokens in the last complete minute; null when counting began after that minute started. */
export function lastMinute(rate: TokenRate, scope: RateScope = {}): number | null {
  const start = Date.parse(rate.minute) - MINUTE_MS;
  if (start < Date.parse(rate.since)) return null;
  return rateSeries(rate, scope).at(-2) ?? 0;
}

/**
 * When counting began, if that was within the hour the series cover: the "60-min" figures then
 * cover only the time since. Null when the whole hour is counted.
 */
export function countedSince(rate: TokenRate): Date | null {
  const since = Date.parse(rate.since);
  const windowStart = Date.parse(rate.minute) - (RATE_MINUTES - 1) * MINUTE_MS;
  return since > windowStart ? new Date(since) : null;
}

/**
 * Index of the first bucket counted whole: the first minute that starts at or after `since`.
 * The minute counting began in is partial, so a line drawn from it would dip.
 */
export function firstCountedIndex(rate: TokenRate): number {
  const minute = Date.parse(rate.minute);
  const first = Math.ceil(Date.parse(rate.since) / MINUTE_MS) * MINUTE_MS;
  const index = RATE_MINUTES - 1 - Math.round((minute - first) / MINUTE_MS);
  return Math.min(RATE_MINUTES - 1, Math.max(0, index));
}

/** Tokens counted in the whole hour of history. */
export function hourTotal(rate: TokenRate, scope: RateScope = {}): number {
  return rateSeries(rate, scope).reduce((a, b) => a + b, 0);
}

/** Running sessions and how many of them are counted, for all agents or one. */
export function rateCoverage(
  rate: TokenRate,
  agent: AgentKind | null = null,
): { running: number; counted: number } {
  if (agent === null) return { running: rate.coverage.running, counted: rate.coverage.counted };
  return rate.coverage.agents[agent] ?? { running: 0, counted: 0 };
}

/** The agent kinds with anything counted in the hour. */
export function rateAgents(rate: TokenRate): AgentKind[] {
  return Object.keys(rate.agents);
}
