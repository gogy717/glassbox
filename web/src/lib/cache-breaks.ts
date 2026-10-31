/**
 * Prompt-cache breaks: the requests whose cached prefix no longer matched, so the context the
 * agent had built up was written to the cache again at the write price instead of read at the
 * read price. Pure functions of a session's requests, each agent read on its own in time order.
 *
 * A request is a *break* when the previous request of the same agent carried a context of more
 * than `MIN_CONTEXT` tokens (its `cacheRead + cacheWrite + input`) and this request read back less
 * than `READ_SHARE` of it from the cache. A continuing request reads the whole previous context
 * and writes only its new turn; a break reads little or none of it. The first request of an agent
 * has nothing before it and is never a break.
 *
 * Its reason, the first that applies:
 * - `compaction`: the agent compacted its context just before (`compactedBefore`);
 * - `shape`: the system prompt or the tools changed (`shapeHash` differs; only where recorded);
 * - `expired`: longer than the cache lives passed between the previous request's end and this
 *   one's start: five minutes, or an hour when the previous request wrote to the hour-long cache;
 * - `rewound`: the context shrank, under `REWOUND_SHARE` of the previous one, with no compaction:
 *   a message was edited, or the conversation resumed from an earlier point;
 * - `unknown`: none of these shows in the data.
 *
 * The tokens written again are estimates: the break's own writes (`cacheWrite + input`) less what
 * a continuing request writes, its new turn, taken as the median `cacheWrite + input` of the
 * agent's other requests (neither breaks nor its first, which writes everything by nature).
 */
import type { Diagnostics, ModelRequest, TokenUsage } from '../../../src/core/model.js';
import { contextSize, emptyUsage } from '../../../src/core/usage.js';
import type { MessageKey, T } from '../i18n';
import { formatDuration } from './format';
import { type Cost, type PriceTable, sumCost } from './prices';

export type CacheBreakReason = 'compaction' | 'shape' | 'expired' | 'rewound' | 'unknown';

export interface CacheBreak {
  request: ModelRequest;
  reason: CacheBreakReason;
  /** The previous request's context, in tokens. */
  before: number;
  /** What this request read back from the cache. */
  read: number;
  /** Tokens written again, estimated: the break's own writes less a usual turn's. */
  rewritten: number;
  /** Time between the previous request's end and this one's start; null when either is unknown. */
  idleMs: number | null;
  /** How long the cache was taken to live after the previous request. */
  ttlMs: number;
}

/** Below this previous context a miss costs little, and system prompts alone come near it. */
export const MIN_CONTEXT = 20_000;
/** A request reading back less than this share of the previous context broke the cache. */
export const READ_SHARE = 0.5;
/** A context under this share of the previous one shrank: the conversation was cut back. */
export const REWOUND_SHARE = 0.9;
/** The API's default cache lifetime, renewed by every read. */
export const TTL_5M = 5 * 60_000;
export const TTL_1H = 60 * 60_000;

/** `Diagnostics.unavailable` key: requests carry no usage of their own (Grok). */
const PER_REQUEST_USAGE = 'per-request-usage';

const time = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);
const byStart = (a: ModelRequest, b: ModelRequest) =>
  (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
const writes = (u: TokenUsage) => u.cacheWrite + u.input;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** The cache's lifetime after `prev`: an hour when every write it made went to the hour cache. */
function ttlAfter(prev: TokenUsage): number {
  return prev.cacheWrite1h > 0 && prev.cacheWrite1h >= prev.cacheWrite ? TTL_1H : TTL_5M;
}

function reasonOf(
  req: ModelRequest,
  prev: ModelRequest,
  before: number,
  idleMs: number | null,
  ttlMs: number,
): CacheBreakReason {
  if (req.compactedBefore) return 'compaction';
  if (req.shapeHash && prev.shapeHash && req.shapeHash !== prev.shapeHash) return 'shape';
  if (idleMs !== null && idleMs > ttlMs) return 'expired';
  if (contextSize(req.usage as TokenUsage) < before * REWOUND_SHARE) return 'rewound';
  return 'unknown';
}

/** The breaks among one agent's requests, in time order; requests without usage are skipped. */
export function agentCacheBreaks(requests: Iterable<ModelRequest>): CacheBreak[] {
  const reqs = [...requests].filter((r) => r.usage).sort(byStart);
  const found: Omit<CacheBreak, 'rewritten'>[] = [];
  const usual: number[] = [];
  reqs.forEach((req, i) => {
    const prev = reqs[i - 1];
    if (!prev) return;
    const usage = req.usage as TokenUsage;
    const prevUsage = prev.usage as TokenUsage;
    const before = contextSize(prevUsage);
    if (before <= MIN_CONTEXT || usage.cacheRead >= before * READ_SHARE) {
      usual.push(writes(usage));
      return;
    }
    const idle = time(req.startedAt) - time(prev.endedAt ?? prev.startedAt);
    const idleMs = Number.isNaN(idle) ? null : Math.max(0, idle);
    const ttlMs = ttlAfter(prevUsage);
    found.push({
      request: req,
      reason: reasonOf(req, prev, before, idleMs, ttlMs),
      before,
      read: usage.cacheRead,
      idleMs,
      ttlMs,
    });
  });
  const turn = median(usual);
  return found.map((b) => ({
    ...b,
    rewritten: Math.max(0, writes(b.request.usage as TokenUsage) - turn),
  }));
}

/** What `cacheBreaks` reads of an open session. */
export interface CacheBreaksInput {
  requests: ReadonlyMap<string, ModelRequest>;
  diagnostics: Diagnostics;
}

export type CacheBreaksResult = { available: false } | { available: true; breaks: CacheBreak[] };

/**
 * The breaks of the given agents (all when none are given), each agent read on its own, listed
 * in time order. Not available when the requests carry no cache figures: the agent reports no
 * usage per request, or none of its requests read from or wrote to a cache.
 */
export function cacheBreaks(
  open: CacheBreaksInput,
  agentIds?: ReadonlySet<string>,
): CacheBreaksResult {
  if (open.diagnostics.unavailable.includes(PER_REQUEST_USAGE)) return { available: false };
  const byAgent = new Map<string, ModelRequest[]>();
  let figures = false;
  for (const r of open.requests.values()) {
    if (agentIds && !agentIds.has(r.agentId)) continue;
    if (r.usage && r.usage.cacheRead + r.usage.cacheWrite > 0) figures = true;
    const list = byAgent.get(r.agentId);
    if (list) list.push(r);
    else byAgent.set(r.agentId, [r]);
  }
  if (!figures) return { available: false };
  const breaks = [...byAgent.values()].flatMap(agentCacheBreaks);
  return { available: true, breaks: breaks.sort((a, b) => byStart(a.request, b.request)) };
}

/** One agent's breaks by request id, for the execution chain's request rows. */
export function cacheBreaksById(open: CacheBreaksInput, agentId: string): Map<string, CacheBreak> {
  const found = cacheBreaks(open, new Set([agentId]));
  return new Map(found.available ? found.breaks.map((b) => [b.request.id, b]) : []);
}

/**
 * What the tokens written again would cost on the API: each break's uncached input and cache
 * writes (five-minute and hour-long in its own proportions) scaled down to the share written
 * again, priced with the request's model.
 */
export function cacheBreakCost(breaks: Iterable<CacheBreak>, table: PriceTable): Cost {
  const parts: { usage: TokenUsage; model: string | null }[] = [];
  for (const b of breaks) {
    const u = b.request.usage as TokenUsage;
    const all = writes(u);
    if (all === 0 || b.rewritten === 0) continue;
    const f = b.rewritten / all;
    parts.push({
      model: b.request.model,
      usage: {
        ...emptyUsage(),
        input: u.input * f,
        cacheWrite: u.cacheWrite * f,
        cacheWrite5m: u.cacheWrite5m * f,
        cacheWrite1h: u.cacheWrite1h * f,
      },
    });
  }
  return sumCost(parts, table);
}

const WORD: Record<CacheBreakReason, MessageKey> = {
  compaction: 'cacheBreaks.reason.compaction',
  shape: 'cacheBreaks.reason.shape',
  expired: 'cacheBreaks.reason.expired',
  rewound: 'cacheBreaks.reason.rewound',
  unknown: 'cacheBreaks.reason.unknown',
};

const WHY: Record<CacheBreakReason, MessageKey> = {
  compaction: 'cacheBreaks.why.compaction',
  shape: 'cacheBreaks.why.shape',
  expired: 'cacheBreaks.why.expired',
  rewound: 'cacheBreaks.why.rewound',
  unknown: 'cacheBreaks.why.unknown',
};

/** A break's reason in a word or two: "expired". */
export const reasonWord = (b: CacheBreak, t: T) => t(WORD[b.reason]);

/** A break's reason in a sentence, for a tooltip: "The cache broke: 6m31s passed since …". */
export function reasonSentence(b: CacheBreak, t: T): string {
  return t(WHY[b.reason], {
    idle: formatDuration(b.idleMs),
    ttl: t(b.ttlMs === TTL_1H ? 'cacheBreaks.ttl1h' : 'cacheBreaks.ttl5m'),
  });
}
