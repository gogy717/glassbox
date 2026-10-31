/**
 * Who used the plan window: `GET /api/quota/burn?provider=<id>&since=<epoch ms>`.
 *
 * The sessions of this machine with requests to the provider started since the window began,
 * each with its tokens by kind, its requests and its share of what those sessions used together.
 * Shares of what glassbox saw here, never a split of the provider's figure: use from other
 * machines and apps is not seen.
 *
 * Counted in total tokens (uncached input, cache reads, cache writes, output): no provider says
 * how its plan weighs each kind, so none is weighed, and the list says so. When none of the
 * sessions reports usage (the Grok CLI does not), the shares are of their requests instead.
 *
 * A CLI that only ever talks to one provider (Claude Code, Codex, Grok) counts against that
 * provider whole; a request of one that can talk to any (oh-my-pi, OpenCode) counts against the
 * provider its model names, and not at all when its model names none.
 */
import type {
  AgentKind,
  QuotaProvider,
  QuotaSnapshot,
  QuotaWindow,
  RepoIdentity,
  TokenUsage,
} from '../core/model.js';

const HOUR_MS = 3_600_000;
const SESSION_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** When no window is known, the list covers this much before now: a session window's length. */
export const BURN_FALLBACK_MS = SESSION_MS;

/** One session's use of the window. */
export interface BurnSession {
  id: string;
  agent: AgentKind;
  /** Raw, as `WeekSession`'s: the client prints them. */
  project: string;
  cwd: string | null;
  /** As `SessionSummary.repo`; absent when the server did not look. */
  repo?: RepoIdentity | null;
  title: string | null;
  /** Its requests' usage since the window began. */
  usage: TokenUsage;
  /** Its requests to the provider started since the window began, finished or not. */
  requests: number;
  /** `burnTokens(usage)`. */
  tokens: number;
  /** Of what the sessions used together, by the answer's `counted`: 0..1. */
  share: number;
}

export interface QuotaBurn {
  provider: QuotaProvider;
  /** Where the window began (epoch ms), as asked. */
  since: number;
  /** When the answer was put together (epoch ms). */
  asOf: number;
  /** Every session with a request since `since`, most tokens first. */
  sessions: BurnSession[];
  /** The sessions' tokens added up. */
  tokens: number;
  /**
   * What the shares are of: 'tokens', or 'requests' when the sessions' requests reported no
   * tokens at all (and then every share is of the requests).
   */
  counted: 'tokens' | 'requests';
}

/** The endpoint's path. */
export const burnPath = (provider: QuotaProvider, since: number) =>
  `/api/quota/burn?provider=${encodeURIComponent(provider)}&since=${Math.round(since)}`;

/** Every kind of token: thinking is part of output, and web searches are not tokens. */
export const burnTokens = (u: TokenUsage) => u.input + u.cacheRead + u.cacheWrite + u.output;

/** The same moment of the calendar month before, in UTC; the 31st of March goes back to 28 February. */
function monthBefore(t: number): number {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Date.UTC(
    y,
    m - 1,
    Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/** A window's length: its source's, else its kind's (a monthly one: the month to its reset). */
export function windowLength(w: QuotaWindow, reset: number): number | null {
  if (w.durationMs !== undefined && w.durationMs > 0) return w.durationMs;
  switch (w.kind) {
    case 'session':
      return SESSION_MS;
    case 'weekly':
    case 'weekly-model':
      return WEEK_MS;
    case 'monthly':
      return reset - monthBefore(reset);
    default:
      return null;
  }
}

/**
 * When the window began (epoch ms): its reset less its length. Null without a reset time, for a
 * window of unknown length, or one past its reset (a window gone by, whose start is not now's).
 */
export function windowStart(w: QuotaWindow, now: number): number | null {
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN;
  if (!Number.isFinite(reset) || reset <= now) return null;
  const length = windowLength(w, reset);
  return length === null ? null : reset - length;
}

/**
 * The window the list covers: the provider's 5-hour window when it has one (the quickest to
 * move, and the one a person waits on), else its current window closest to its limit. Null when
 * no window is current.
 */
export function burnWindow(q: QuotaSnapshot | null | undefined, now: number): QuotaWindow | null {
  const current = (q?.windows ?? []).filter((w) => windowStart(w, now) !== null);
  return (
    current.find((w) => w.kind === 'session') ??
    current.reduce<QuotaWindow | null>(
      (a, b) => (!a || b.usedPercent > a.usedPercent ? b : a),
      null,
    )
  );
}

/** Where the list starts: the window's start, else `BURN_FALLBACK_MS` before now. */
export function burnSince(q: QuotaSnapshot | null | undefined, now: number): number {
  const w = burnWindow(q, now);
  return (w && windowStart(w, now)) ?? now - BURN_FALLBACK_MS;
}

/** The provider of every request of an agent that only ever talks to one. */
const SINGLE_PROVIDER: Partial<Record<AgentKind, QuotaProvider>> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  grok: 'xai',
};

/** A model's provider, by its name: an explicit `provider/` prefix first, then the family. */
function modelProvider(model: string): QuotaProvider | null {
  const m = model.toLowerCase();
  const prefix = m.includes('/') ? m.slice(0, m.indexOf('/')) : '';
  if (/copilot/.test(prefix)) return 'github-copilot';
  const name = /^(anthropic|openai|xai|deepseek)$/.test(prefix) ? prefix : m;
  if (/anthropic|claude/.test(name)) return 'anthropic';
  if (/xai|grok/.test(name)) return 'xai';
  if (/deepseek/.test(name)) return 'deepseek';
  if (/openai|gpt|codex|(^|\/)o\d/.test(name)) return 'openai';
  return null;
}

/** The provider a request of `agent` to `model` counts against; null when it cannot be told. */
export function requestProvider(agent: AgentKind, model: string | null): QuotaProvider | null {
  return SINGLE_PROVIDER[agent] ?? (model ? modelProvider(model) : null);
}

/** Whether a session of `agent` may have used `provider`'s plan at all. */
export function mayUse(agent: AgentKind, provider: QuotaProvider): boolean {
  const single = SINGLE_PROVIDER[agent];
  return single === undefined || single === provider;
}

/** The first `n` sessions, and the rest folded into one "and N more" with their tokens and share. */
export function topBurn(
  sessions: readonly BurnSession[],
  n: number,
): { top: BurnSession[]; more: { count: number; tokens: number; share: number } } {
  const rest = sessions.slice(n);
  return {
    top: sessions.slice(0, n),
    more: {
      count: rest.length,
      tokens: rest.reduce((a, s) => a + s.tokens, 0),
      share: rest.reduce((a, s) => a + s.share, 0),
    },
  };
}
