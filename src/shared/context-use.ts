/**
 * How full an agent's context is: what its latest finished model call read (uncached input,
 * cache reads, cache writes: the chain's "context") against its model's window, where the window
 * is known. Agent-neutral and pure: the server sends the main agent's with a running session's
 * summary (`SessionSummary.contextUse`), the signs of trouble raise 'context-full' from it, and
 * the session page shows it for the agent it shows.
 *
 * Windows, by model id: a Claude model's is 200K, or 1M for an id that names 1M ("…[1m]") and
 * for an agent whose context has gone past 200K: Claude Code's transcripts name the model
 * without its 1M tag, and a call that read more than 200K proves the larger window. Any other
 * model's window is not known (no table of them here), so it has no share and raises no sign.
 */
import type { ContextUse, ModelRequest } from '../core/model.js';
import { contextSize } from '../core/usage.js';

export type { ContextUse };

/** A Claude model's window, and the larger one some offer. */
export const CLAUDE_WINDOW = 200_000;
export const LARGE_WINDOW = 1_000_000;

/** The share of its window at which an agent's context is nearly full. */
export const CONTEXT_FULL = 0.85;

/** "1m" as a word of a model id: "claude-opus-5-5[1m]", "…-1m". */
const NAMES_1M = /(?:^|[^a-z0-9])1m(?:$|[^a-z0-9])/;

/**
 * The window of `model`, in tokens; null when not known. `seen`: the most the agent's context
 * has held, which past 200K makes a Claude model's window 1M.
 */
export function contextWindow(model: string | null | undefined, seen = 0): number | null {
  const id = model?.trim().toLowerCase() ?? '';
  if (NAMES_1M.test(id)) return LARGE_WINDOW;
  if (!id.includes('claude')) return null;
  return seen > CLAUDE_WINDOW ? LARGE_WINDOW : CLAUDE_WINDOW;
}

/** The few fields of a model call the figure is read from. */
export type ContextRequest = Pick<ModelRequest, 'id' | 'agentId' | 'startedAt'> &
  Partial<Pick<ModelRequest, 'usage' | 'model' | 'compactedBefore'>>;

/** Epoch ms of a start; one not known sorts last, as one not recorded yet is the latest. */
const startOf = (r: ContextRequest) => {
  const t = r.startedAt ? Date.parse(r.startedAt) : Number.NaN;
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

/**
 * `agentId`'s context as of its latest finished call: null when none of its calls read any yet,
 * or when a call started after that one follows a compaction (the context it read is gone; the
 * next figure comes when that call finishes).
 */
export function contextUse(requests: Iterable<ContextRequest>, agentId: string): ContextUse | null {
  let latest: { r: ContextRequest; tokens: number; at: number } | null = null;
  let compacted = Number.NEGATIVE_INFINITY;
  let seen = 0;
  for (const r of requests) {
    if (r.agentId !== agentId) continue;
    const at = startOf(r);
    if (r.compactedBefore) compacted = Math.max(compacted, at);
    const tokens = r.usage ? contextSize(r.usage) : 0;
    if (tokens <= 0) continue;
    seen = Math.max(seen, tokens);
    if (!latest || at >= latest.at) latest = { r, tokens, at };
  }
  if (!latest || compacted > latest.at) return null;
  return {
    agentId,
    requestId: latest.r.id,
    tokens: latest.tokens,
    window: contextWindow(latest.r.model, seen),
  };
}
