/** Pure helpers behind the execution-chain (flow) tab. */
import type {
  ModelRequest,
  RunStatus,
  TokenUsage,
  ToolCall,
  Turn,
} from '../../../../src/core/model.js';
import { contextSize } from '../../../../src/core/usage.js';
import type { UiStatus } from '../../components/Status';
import type { Approvals } from '../../data/approvals';
import type { OpenSession } from '../../data/store';

/**
 * First `max` code points with whitespace collapsed, plus "…" when cut. Turn-list titles: CSS
 * ellipsizes them to the card's width, this only keeps a pasted 50 KB prompt out of the DOM.
 */
export function truncatePrompt(prompt: string, max = 120): string {
  const points = [...prompt.replace(/\s+/g, ' ').trim()];
  return points.length > max ? `${points.slice(0, max).join('').trimEnd()}…` : points.join('');
}

const OUTSIDE = 'outside:';

/** True for the pseudo-turn that holds an agent's requests that belong to no turn. */
export const isOutsideTurn = (t: Turn) => t.id.startsWith(OUTSIDE);

/** A command name, then arguments or nothing: "/effort", "/model opus"; a path "/home/…" is not. */
const COMMAND = /^\/[A-Za-z][\w:.-]*(\s|$)/;

/**
 * A person's slash command that never reached the model (Claude Code runs /effort, /clear and
 * /login itself). The model has no flag for it, so: a command-shaped prompt, finished, no calls.
 */
export function isLocalCommand(turn: Turn, calls: number, status: UiStatus): boolean {
  return (
    turn.origin === 'human' &&
    calls === 0 &&
    status !== 'running' &&
    status !== 'approval' &&
    COMMAND.test(turn.prompt.trim())
  );
}

/**
 * Requests the adapter could not place in a turn (e.g. before the agent's first prompt) are
 * gathered in one pseudo-turn, so every view shows every request the summary bar counts.
 */
function outsideTurn(open: OpenSession, agentId: string): Turn | null {
  const reqs: ModelRequest[] = [];
  for (const r of open.requests.values())
    if (r.agentId === agentId && r.turnId === null) reqs.push(r);
  if (reqs.length === 0) return null;
  reqs.sort((a, b) => startKey(a).localeCompare(startKey(b)));
  const running = reqs.some((r) => r.status === 'in-flight');
  const ends = reqs.map((r) => r.endedAt).filter((e): e is string => !!e);
  return {
    id: `${OUTSIDE}${agentId}`,
    agentId,
    index: 0,
    origin: 'other',
    prompt: '',
    startedAt: reqs[0]?.startedAt ?? new Date(0).toISOString(),
    endedAt: running ? null : (ends.sort().at(-1) ?? null),
    status: running ? 'running' : 'complete',
    requestIds: reqs.map((r) => r.id),
  };
}

export function turnsOf(open: OpenSession, agentId: string): Turn[] {
  const out: Turn[] = [];
  for (const t of open.turns.values()) if (t.agentId === agentId) out.push(t);
  const outside = outsideTurn(open, agentId);
  if (outside) out.push(outside);
  // Real turns are numbered in time order; the pseudo-turn sits where its first call happened.
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.index - b.index);
}

/** A turn by id, including the pseudo-turn of calls outside any turn. */
export function findTurn(open: OpenSession, agentId: string, turnId: string): Turn | undefined {
  if (turnId === `${OUTSIDE}${agentId}`) return outsideTurn(open, agentId) ?? undefined;
  const t = open.turns.get(turnId);
  return t && t.agentId === agentId ? t : undefined;
}

// Indexes are rebuilt only when the underlying map changes (the store copies on write).
const requestsByTurn = new WeakMap<Map<string, ModelRequest>, Map<string, ModelRequest[]>>();
const toolsByRequest = new WeakMap<Map<string, ToolCall>, Map<string, ToolCall[]>>();

function groupBy<T>(items: Iterable<T>, key: (t: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

function cached<K extends object, V>(cache: WeakMap<K, V>, key: K, build: () => V): V {
  let v = cache.get(key);
  if (!v) {
    v = build();
    cache.set(key, v);
  }
  return v;
}

const startKey = (r: ModelRequest) => r.startedAt ?? '';

/**
 * A turn's requests. Patches can arrive in any order, so this unions the turn's own list with
 * requests that point at the turn, and skips ids that have not arrived yet.
 */
export function requestsOf(open: OpenSession, turn: Turn): ModelRequest[] {
  const index = cached(requestsByTurn, open.requests, () =>
    groupBy(open.requests.values(), (r) => r.turnId),
  );
  const seen = new Set<string>();
  const out: ModelRequest[] = [];
  const add = (r: ModelRequest | undefined) => {
    if (r && !seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  };
  for (const id of turn.requestIds) add(open.requests.get(id));
  for (const r of index.get(turn.id) ?? []) add(r);
  // Calls outside a turn have no meaningful index; their order is time.
  if (isOutsideTurn(turn)) return out;
  return out.sort((a, b) => a.index - b.index || startKey(a).localeCompare(startKey(b)));
}

/** A request's tool calls in response-block order, then any the request does not list yet. */
export function toolsOf(open: OpenSession, req: ModelRequest): ToolCall[] {
  const index = cached(toolsByRequest, open.toolCalls, () =>
    groupBy(open.toolCalls.values(), (t) => t.requestId),
  );
  const out: ToolCall[] = [];
  const seen = new Set<string>();
  for (const id of req.toolCallIds) {
    const t = open.toolCalls.get(id);
    if (t && !seen.has(id)) {
      seen.add(id);
      out.push(t);
    }
  }
  for (const t of index.get(req.id) ?? []) if (!seen.has(t.id)) out.push(t);
  return out;
}

/** Running, but blocked on a permission prompt the person has not answered yet. */
const isAwaiting = (tool: ToolCall, approvals?: Approvals) =>
  tool.status === 'running' && approvals?.get(tool.id)?.decidedAt === null;

export function toolStatus(tool: ToolCall, approvals?: Approvals): UiStatus {
  switch (tool.status) {
    case 'running':
      return isAwaiting(tool, approvals) ? 'approval' : 'running';
    case 'complete':
      return 'complete';
    case 'error':
      return 'error';
    default:
      // Started but never finished in a session that has since closed.
      return 'waiting';
  }
}

export function callStatus(req: ModelRequest, tools: ToolCall[], approvals?: Approvals): UiStatus {
  if (req.status === 'error' || tools.some((t) => t.status === 'error')) return 'error';
  if (tools.some((t) => isAwaiting(t, approvals))) return 'approval';
  if (req.status === 'in-flight' || tools.some((t) => t.status === 'running')) return 'running';
  if (req.status === 'interrupted') return 'interrupted';
  return req.status === 'complete' ? 'complete' : 'waiting';
}

const RUN_STATUS: Record<RunStatus, UiStatus> = {
  running: 'running',
  complete: 'complete',
  error: 'error',
  interrupted: 'interrupted',
  unknown: 'waiting',
};

/**
 * Waiting for approval if any call is, running if any call runs, else the last call's status: a
 * recovered failure reads complete.
 */
export function turnStatus(turn: Turn, calls: UiStatus[]): UiStatus {
  if (calls.length === 0) return RUN_STATUS[turn.status];
  if (calls.includes('approval')) return 'approval';
  // Between calls (or with no in-flight record) the turn itself knows it is still going.
  if (turn.status === 'running' || calls.includes('running')) return 'running';
  return calls.at(-1) as UiStatus;
}

export interface TokenHeader {
  input: number;
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
  /** DSH shows "uncached" only when the cache was involved; otherwise it equals input. */
  showUncached: boolean;
}

export function tokenHeader(u: TokenUsage | null): TokenHeader | null {
  if (!u) return null;
  return {
    input: contextSize(u),
    uncached: u.input,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    output: u.output,
    thinking: u.thinking,
    showUncached: u.cacheRead > 0 || u.cacheWrite > 0,
  };
}

/**
 * Older Claude Code versions write no request-start record; the adapter then reports the start
 * as the end, so the duration is unknown, not zero.
 */
export const startUnknown = (req: ModelRequest) =>
  req.status !== 'in-flight' && !!req.startedAt && req.startedAt === req.endedAt;

export function requestDurationMs(req: ModelRequest, now: number): number | null {
  if (!req.startedAt || startUnknown(req)) return null;
  const end = req.endedAt ? Date.parse(req.endedAt) : req.status === 'in-flight' ? now : null;
  return end === null ? null : Math.max(0, end - Date.parse(req.startedAt));
}
