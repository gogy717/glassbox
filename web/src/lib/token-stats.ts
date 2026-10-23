/** Token accounting behind the "where the tokens went" tab. Pure functions of the open session. */
import type { AgentNode, ModelRequest, TokenUsage } from '../../../src/core/model.js';
import { addUsage, contextSize, emptyUsage, totalTokens } from '../../../src/core/usage.js';
import type { OpenSession } from '../data/store';
import { agentTree, subtreeIds } from './agents';

export type RollupRow =
  | {
      kind: 'agent';
      depth: number;
      id: string;
      label: string;
      agent: AgentNode;
      /** This agent's own requests. */
      own: TokenUsage;
      /** Own plus every descendant agent. */
      total: TokenUsage;
    }
  | { kind: 'workflow' | 'phase'; depth: number; id: string; label: string; total: TokenUsage };

const copy = (u: TokenUsage) => addUsage(emptyUsage(), u);

function subtreeUsage(open: OpenSession, agentId: string): TokenUsage {
  const total = emptyUsage();
  for (const id of subtreeIds(open, agentId)) {
    const a = open.agents.get(id);
    if (a) addUsage(total, a.usage);
  }
  return total;
}

/** The agent tree with usage: agents carry own + subtree totals, groups carry member totals. */
export function rollupByAgent(open: OpenSession): RollupRow[] {
  const rows: RollupRow[] = [];
  const members = (pred: (a: AgentNode) => boolean) => {
    const total = emptyUsage();
    for (const a of open.agents.values()) if (pred(a)) addUsage(total, subtreeUsage(open, a.id));
    return total;
  };
  for (const r of agentTree(open)) {
    if (r.kind === 'agent') {
      rows.push({
        kind: 'agent',
        depth: r.depth,
        id: r.agent.id,
        label: r.agent.label,
        agent: r.agent,
        own: copy(r.agent.usage),
        total: subtreeUsage(open, r.agent.id),
      });
    } else if (r.kind === 'workflow') {
      rows.push({
        kind: 'workflow',
        depth: r.depth,
        id: r.workflow.id,
        label: r.workflow.name ?? r.workflow.id,
        total: members((a) => a.workflowRunId === r.workflow.id),
      });
    } else {
      rows.push({
        kind: 'phase',
        depth: r.depth,
        id: `${r.workflowId}:${r.title}`,
        label: r.title,
        total: members((a) => a.workflowRunId === r.workflowId && a.phase === r.title),
      });
    }
  }
  return rows;
}

export interface ContextPoint {
  requestId: string;
  /** Turn number as the execution chain shows it; null for calls outside any turn. */
  turn: number | null;
  /** Call number within the turn. */
  call: number;
  at: string | null;
  context: number;
  output: number;
  /** The context shrank sharply since the previous request: the conversation was compacted. */
  compacted: boolean;
}

/**
 * Fallback for adapters that cannot mark compactions: a drop below this share of the previous
 * request's context is read as one. Real compactions cut far deeper; turns only grow.
 */
const COMPACTION_RATIO = 0.7;
/** `Diagnostics.unavailable` key: the adapter cannot mark compactions exactly. */
export const COMPACTION_MARKERS = 'compaction-markers';

const byStart = (a: ModelRequest, b: ModelRequest) =>
  (a.startedAt ?? '').localeCompare(b.startedAt ?? '');

export function contextSeries(open: OpenSession, agentId: string): ContextPoint[] {
  const reqs = [...open.requests.values()]
    .filter((r) => r.agentId === agentId && r.usage)
    .sort(byStart);
  // Adapters that cannot detect compactions say so in diagnostics; only then do we guess.
  const guess = open.diagnostics.unavailable.includes(COMPACTION_MARKERS);
  let prev: number | null = null;
  return reqs.map((r) => {
    const usage = r.usage as TokenUsage;
    const context = contextSize(usage);
    const compacted =
      r.compactedBefore === true || (guess && prev !== null && context < prev * COMPACTION_RATIO);
    prev = context;
    const turn = r.turnId ? (open.turns.get(r.turnId)?.index ?? null) : null;
    return {
      requestId: r.id,
      turn,
      call: r.index,
      at: r.startedAt,
      context,
      output: usage.output,
      compacted,
    };
  });
}

/** The costliest finished requests, optionally only those of the given agents. */
export function topRequests(open: OpenSession, n: number, agentIds?: Set<string>): ModelRequest[] {
  return [...open.requests.values()]
    .filter((r) => r.usage && (!agentIds || agentIds.has(r.agentId)))
    .sort((a, b) => totalTokens(b.usage as TokenUsage) - totalTokens(a.usage as TokenUsage))
    .slice(0, n);
}

export type Insight =
  | { key: 'tokens.insightCacheRead'; share: number }
  | { key: 'tokens.insightAgent'; share: number; agentId: string; label: string };

const CACHE_READ_SHARE = 0.6;
const AGENT_SHARE = 0.5;

/** One-line conclusions for the top of the tab, most general first. */
export function insights(open: OpenSession): Insight[] {
  const all = emptyUsage();
  const spenders: AgentNode[] = [];
  for (const a of open.agents.values()) {
    addUsage(all, a.usage);
    if (totalTokens(a.usage) > 0) spenders.push(a);
  }
  const total = totalTokens(all);
  if (total === 0) return [];
  const out: Insight[] = [];
  if (all.cacheRead / total >= CACHE_READ_SHARE)
    out.push({ key: 'tokens.insightCacheRead', share: all.cacheRead / total });
  // "X spent half" only means something when more than one agent spent anything.
  if (spenders.length > 1) {
    const top = spenders.reduce((a, b) => (totalTokens(b.usage) > totalTokens(a.usage) ? b : a));
    const share = totalTokens(top.usage) / total;
    if (share >= AGENT_SHARE)
      out.push({ key: 'tokens.insightAgent', share, agentId: top.id, label: top.label });
  }
  return out;
}
