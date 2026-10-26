/**
 * What a session's receipt says, taken from the functions behind the app's own figures: the
 * Summary bar's `summarize`, the Timeline's `timeBreakdown` and segments, the Tokens tab's
 * `rollupByAgent`. Nothing here counts anything new, so the receipt always agrees with the app.
 */
import { type AgentKind, MAIN_AGENT_ID } from '../../../../src/core/model.js';
import { totalTokens } from '../../../../src/core/usage.js';
import type { Approvals } from '../../data/approvals';
import type { OpenSession } from '../../data/store';
import { mayStillRun, subtreeCost, summarize } from '../../lib/agents';
import { type Cost, DEFAULT_PRICES, type PriceTable } from '../../lib/prices';
import { type Segment, timeBreakdown, timeSegments } from '../../lib/time-stats';
import { rollupByAgent } from '../../lib/token-stats';
import { type ToolCategory, toolCategory } from '../../lib/tool-category';
import { clean, printedProject, printedTitle } from './printed';

export interface ReceiptData {
  agent: AgentKind;
  model: string | null;
  /** The first model call's reasoning effort ("max"), when the agent records one. */
  effort: string | null;
  nativeId: string;
  /** Epoch ms; null when the session never said when it started. */
  start: number | null;
  /** Its last write, or now while it still runs. */
  end: number;
  running: boolean;
  /**
   * The working directory's last segment; else the agent's project name if it reads as one, not
   * as an encoded path (`-home-<user>-dev-app`, which would print a user name). Null otherwise.
   */
  project: string | null;
  /**
   * Masked (`redact`), as a first prompt can hold a pasted key, with any absolute path in it cut
   * to its last segment. Null when untitled.
   */
  title: string | null;
  /** The Summary bar's duration; null before any model call, as the bar shows a dash. */
  durationMs: number | null;
  work: {
    requests: number;
    toolCalls: number;
    /** The three biggest tool categories, then the rest as 'other'. */
    categories: { category: ToolCategory; count: number }[];
    subAgents: number;
    turns: number;
    failures: number;
    compactions: number;
  };
  time: {
    thinking: number;
    generating: number;
    tools: number;
    approval: number;
    queued: number;
    longestThink: number;
  };
  tokens: {
    /** False until a call reported usage: the figures are then unknown, not zero. */
    measured: boolean;
    cacheRead: number;
    cacheWrite: number;
    uncached: number;
    output: number;
    thinking: number;
    cacheHit: number | null;
    total: number;
    /** What the same tokens would cost on the API, an estimate; null when no call was priced. */
    cost: Cost | null;
  };
  /** The main agent's timeline, each sub-agent's span and each one's timeline: the barcode. */
  segments: Segment[];
  subAgents: [number, number][];
  subSegments: Segment[][];
  failedTools: ReadonlySet<string>;
}

const ms = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

/** `prices`: the API price table for the API equivalent (the person's, from Settings). */
export function receiptData(
  open: OpenSession,
  now: number,
  approvals?: Approvals,
  prices: PriceTable = DEFAULT_PRICES,
): ReceiptData {
  const s = summarize(open, MAIN_AGENT_ID, now);
  const cost = subtreeCost(open, MAIN_AGENT_ID, prices);
  const running = mayStillRun(open, MAIN_AGENT_ID);
  const breakdown = timeBreakdown(open, MAIN_AGENT_ID, now, approvals);
  const lanes = timeSegments(open, now, approvals);
  const segments = lanes.find((l) => l.agentId === MAIN_AGENT_ID)?.segments ?? [];

  const byCategory = new Map<ToolCategory, number>();
  const failedTools = new Set<string>();
  for (const t of open.toolCalls.values()) {
    const c = toolCategory(t.name, t.input);
    byCategory.set(c, (byCategory.get(c) ?? 0) + 1);
    if (t.status === 'error') failedTools.add(t.id);
  }
  const ranked = [...byCategory].filter(([c]) => c !== 'other').sort((a, b) => b[1] - a[1]);
  const other = (byCategory.get('other') ?? 0) + ranked.slice(3).reduce((n, [, k]) => n + k, 0);
  const categories = ranked.slice(0, 3).map(([category, count]) => ({ category, count }));
  if (other > 0) categories.push({ category: 'other', count: other });

  let failures = failedTools.size;
  let compactions = 0;
  let effort: string | null = null;
  let firstAt = Number.POSITIVE_INFINITY;
  for (const r of open.requests.values()) {
    if (r.status === 'error') failures++;
    if (r.compactedBefore) compactions++;
    const at = ms(r.startedAt);
    if (r.agentId === MAIN_AGENT_ID && r.effort && at !== null && at < firstAt) {
      firstAt = at;
      effort = r.effort;
    }
  }

  const root = rollupByAgent(open).find((r) => r.kind === 'agent' && r.id === MAIN_AGENT_ID);
  const usage = root?.total;
  const subAgents: [number, number][] = [];
  for (const a of open.agents.values()) {
    if (a.id === MAIN_AGENT_ID) continue;
    const from = ms(a.startedAt);
    if (from !== null) subAgents.push([from, ms(a.endedAt) ?? (running ? now : from)]);
  }

  return {
    agent: open.session.agent,
    model: open.session.model ? clean(open.session.model) : null,
    effort: effort ? clean(effort) : null,
    nativeId: open.session.nativeId,
    start: ms(open.session.startedAt),
    end: running ? now : (ms(open.session.updatedAt) ?? now),
    running,
    project: printedProject(open.session.cwd, open.session.project),
    title: open.session.title ? printedTitle(open.session.title) : null,
    durationMs: s.requests === 0 ? null : s.activeMs,
    work: {
      requests: s.requests,
      toolCalls: s.toolCalls,
      categories,
      subAgents: Math.max(0, open.agents.size - 1),
      turns: s.turns,
      failures,
      compactions,
    },
    time: {
      thinking: breakdown.model.thinking,
      generating: breakdown.model.generating,
      tools: Object.values(breakdown.tools).reduce((a, b) => a + (b ?? 0), 0),
      approval: breakdown.approval,
      queued: breakdown.model.waiting,
      longestThink: segments.reduce(
        (m, g) => (g.kind === 'thinking' ? Math.max(m, g.end - g.start) : m),
        0,
      ),
    },
    tokens: {
      measured: s.measured,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      uncached: usage?.input ?? 0,
      output: usage?.output ?? 0,
      thinking: usage?.thinking ?? 0,
      cacheHit: s.cacheHitRate,
      total: usage ? totalTokens(usage) : 0,
      cost: cost.priced ? cost : null,
    },
    segments,
    subAgents,
    subSegments: lanes.filter((l) => l.agentId !== MAIN_AGENT_ID).map((l) => l.segments),
    failedTools,
  };
}
