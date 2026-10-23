/**
 * Mutable per-entity state the parser accumulates. Statuses are not stored: they are derived
 * when an entity is materialised, because they depend on later records and on live state.
 */
import type {
  AgentNodeKind,
  ModelRequest,
  ResponseBlock,
  RunStatus,
  TokenUsage,
  TurnOrigin,
} from '../../core/model.js';

export interface AgentState {
  id: string;
  kind: AgentNodeKind;
  parentId: string | null;
  spawnedByToolCallId: string | null;
  agentType: string | null;
  label: string;
  workflowRunId: string | null;
  phase: string | null;
  turnIds: string[];
  requestIds: string[];
  toolCallIds: string[];
  /** Label from meta (`description`); wins over labels inferred from the spawning call. */
  metaLabel: string | null;
  /** Meta `finished: true`. */
  finished: boolean;
  /** Explicit end from a task notification or the parent's tool result. */
  end: { status: RunStatus; at: string | null } | null;
  /** Latest record time in this agent's transcript. */
  lastTs: string | null;
  /** `lastTs` before the record being ingested: the previous record's time. */
  prevTs: string | null;
  /** The context was compacted; the next request starts from the summary. */
  compactPending: boolean;
}

export interface TurnState {
  id: string;
  agentId: string;
  index: number;
  origin: TurnOrigin;
  prompt: string;
  sender: string | null;
  startedAt: string;
  requestIds: string[];
  /** Set by an interrupt marker while this turn was the agent's latest. */
  interruptedAt: string | null;
  /** Set by a `turn_duration` record. */
  endMarkAt: string | null;
  /** The prompt was a slash command; with no request it was local and names nothing. */
  command: boolean;
}

export interface RequestState {
  id: string;
  agentId: string;
  turnId: string | null;
  index: number;
  /** Timestamp of the `api-request` record, when there is one. */
  apiTs: string | null;
  /** Time of the agent's previous record when this request was first seen (its trigger). */
  triggerTs: string | null;
  hasApi: boolean;
  apiModel: string | null;
  apiEffort: string | null;
  model: string | null;
  effort: string | null;
  stopReason: string | null;
  /** Usage of the record with the largest `output_tokens` so far. */
  usage: TokenUsage | null;
  bestOutput: number;
  /** Response blocks keyed by position (`apiBlockIndex`, else arrival order). */
  blocks: Map<number, { block: ResponseBlock; thinkingMs: number | null }>;
  arrivals: number;
  toolCallIds: string[];
  interruptedAt: string | null;
  error: ModelRequest['error'];
  compactedBefore: boolean;
}

export interface ToolState {
  id: string;
  agentId: string;
  requestId: string;
  name: string;
  input: unknown;
  startedAt: string | null;
  result: { content: unknown; toolUseResult: unknown; isError: boolean; at: string | null } | null;
}

export function newAgent(id: string, kind: AgentNodeKind, label: string): AgentState {
  return {
    id,
    kind,
    parentId: null,
    spawnedByToolCallId: null,
    agentType: null,
    label,
    workflowRunId: null,
    phase: null,
    turnIds: [],
    requestIds: [],
    toolCallIds: [],
    metaLabel: null,
    finished: false,
    end: null,
    lastTs: null,
    prevTs: null,
    compactPending: false,
  };
}

export function newRequest(
  id: string,
  agentId: string,
  turnId: string | null,
  index: number,
): RequestState {
  return {
    id,
    agentId,
    turnId,
    index,
    apiTs: null,
    triggerTs: null,
    hasApi: false,
    apiModel: null,
    apiEffort: null,
    model: null,
    effort: null,
    stopReason: null,
    usage: null,
    bestOutput: -1,
    blocks: new Map(),
    arrivals: 0,
    toolCallIds: [],
    interruptedAt: null,
    error: null,
    compactedBefore: false,
  };
}

/** Blocks in response order. */
export function orderedBlocks(r: RequestState) {
  return [...r.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
}

const shift = (iso: string, ms: number) => {
  const t = Date.parse(iso) - ms;
  return Number.isFinite(t) && !Number.isNaN(new Date(t).getTime())
    ? new Date(t).toISOString()
    : iso;
};

/**
 * The api-request time when there is one. Otherwise the earlier of the record that triggered
 * the request and, for thinking, the first block's completion minus its thinking time.
 */
export function requestStart(r: RequestState): string | null {
  if (r.apiTs) return r.apiTs;
  const first = orderedBlocks(r)[0];
  const candidates = [
    r.triggerTs,
    first ? (first.thinkingMs ? shift(first.block.at, first.thinkingMs) : first.block.at) : null,
  ].filter((t): t is string => t !== null && !Number.isNaN(Date.parse(t)));
  if (candidates.length === 0) return first?.block.at ?? null;
  return candidates.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
}
