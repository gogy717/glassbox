/**
 * Signs that an agent left alone is stuck, read from a session's entities: the same call over
 * and over, calls failing in a row, model calls erroring, a prompt running far longer than the
 * others, the context compacted again and again, a wait for the person going on. Agent-neutral
 * and pure: the summary bar lists them for the agent it shows, and the server sends a session's
 * strongest (`SessionSummary.trouble`) so its row can say it.
 */
import type {
  AgentNode,
  IsoTime,
  ModelRequest,
  SessionSummary,
  ToolCall,
  Turn,
} from '../core/model.js';
import { MAIN_AGENT_ID } from '../core/model.js';
import { SHELL_TOOLS, shellCommand } from './tool-category.js';

/** Strongest first: the order in which the summary bar lists them, and the server picks one. */
export const TROUBLE_KINDS = [
  'repeat',
  'failing',
  'errors',
  'waiting',
  'long-turn',
  'compaction',
] as const;
export type TroubleKind = (typeof TROUBLE_KINDS)[number];

/** What a sign points at: a tool call, a model call or a prompt, with whose it is. */
export type TroubleRef =
  | { kind: 'tool'; agentId: string; requestId: string; toolCallId: string }
  | { kind: 'request'; agentId: string; requestId: string }
  | { kind: 'turn'; agentId: string; turnId: string };

/**
 * One sign of trouble, as data: the UI words it by `kind` from `params`, never a sentence.
 * - 'repeat': `n` calls in a row the same; `x` names the call.
 * - 'failing': `n` tool calls failed in a row.
 * - 'errors': `n` of the last `of` model calls failed.
 * - 'waiting': waiting for the person, since `since`.
 * - 'long-turn': the running prompt, since `since`, against the others' `median` (ms).
 * - 'compaction': the context was compacted `n` times.
 */
export interface TroubleSignal {
  kind: TroubleKind;
  params: Record<string, string | number>;
  at: TroubleRef | null;
  /** When it began: the first call of the streak, the first error, the wait, the prompt. */
  since: IsoTime | null;
}

type Agent = Pick<AgentNode, 'id' | 'parentId' | 'status'>;
type Prompt = Pick<Turn, 'id' | 'agentId' | 'startedAt' | 'endedAt' | 'status'>;
type Request = Pick<
  ModelRequest,
  'id' | 'agentId' | 'turnId' | 'status' | 'startedAt' | 'compactedBefore'
>;
type Tool = Pick<
  ToolCall,
  'id' | 'agentId' | 'requestId' | 'name' | 'input' | 'status' | 'startedAt'
>;

/** What the signs are read from: the few fields of a session's entities they need, by id. */
export interface TroubleInput<T extends Tool = Tool> {
  session: Pick<SessionSummary, 'live' | 'activity' | 'updatedAt'>;
  agents: ReadonlyMap<string, Agent>;
  turns: ReadonlyMap<string, Prompt>;
  requests: ReadonlyMap<string, Request>;
  toolCalls: ReadonlyMap<string, T>;
}

/** Calls in a row that make a streak, of the same call or of failures. */
const STREAK = 3;
/** Failed model calls among the last `ERROR_WINDOW` that make a sign. */
const ERRORS = 2;
const ERROR_WINDOW = 10;
const MINUTE = 60_000;
/** A running prompt is long past this many times the others' median, and past `LONG_MS`. */
const LONG_FACTOR = 3;
const LONG_MS = 10 * MINUTE;
const COMPACTIONS = 3;
const WAIT_MS = 10 * MINUTE;

/**
 * Tools whose same call again is waiting, not a loop: a background shell's or task's output, a
 * wait on agents or commands, Codex's empty write to a running command.
 */
const POLLING = new Set([
  'BashOutput',
  'TaskOutput',
  'TaskList',
  'TaskGet',
  'Monitor',
  'write_stdin',
  'wait',
  'wait_agent',
  'AwaitShell',
  'get_command_or_subagent_output',
  'wait_commands_or_subagents',
  'get_task_output',
  'wait_tasks',
  'vibe_wait',
  'vibe_list',
]);

const ms = (iso: IsoTime | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Oldest first; a start not known goes last, as one not recorded yet is the latest. */
function byStart<X extends { startedAt: IsoTime | null }>(items: X[]): X[] {
  return items
    .map((x) => [ms(x.startedAt), x] as const)
    .sort(([a], [b]) =>
      Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : Number.isNaN(b) ? -1 : a - b,
    )
    .map(([, x]) => x);
}

/** The agent and every agent under it, by their parents; a cycle in bad data ends the walk. */
export function agentSubtree(
  agents: ReadonlyMap<string, Pick<AgentNode, 'id' | 'parentId'>>,
  rootId: string,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const a of agents.values())
    if (a.parentId !== null && a.parentId !== a.id) push(children, a.parentId, a.id);
  const ids = new Set([rootId]);
  const queue = [rootId];
  for (let id = queue.shift(); id !== undefined; id = queue.shift())
    for (const child of children.get(id) ?? [])
      if (!ids.has(child)) {
        ids.add(child);
        queue.push(child);
      }
  return ids;
}

/**
 * What makes two calls the same call: a shell command by its line, whitespace aside (the line
 * the call's summary shows, whole); any other tool by its name and its input. Null for a call
 * that repeats by nature, a poll, a wait, a `sleep` before a look.
 */
function sameKey(tool: Tool): string | null {
  if (POLLING.has(tool.name)) return null;
  const line = SHELL_TOOLS.has(tool.name) ? shellCommand(tool.input) : null;
  if (line !== null)
    return /^\s*sleep\s/.test(line) ? null : `$ ${line.replace(/\s+/g, ' ').trim()}`;
  try {
    return `${tool.name} ${JSON.stringify(tool.input) ?? ''}`;
  } catch {
    // Nested past what JSON can write: never the same as anything.
    return null;
  }
}

const toolRef = (t: Tool): TroubleRef => ({
  kind: 'tool',
  agentId: t.agentId,
  requestId: t.requestId,
  toolCallId: t.id,
});

/** The same call `STREAK` or more times in a row at the end of an agent's calls. */
function repeat<T extends Tool>(calls: T[], label: (tool: T) => string): TroubleSignal | null {
  const last = calls.at(-1);
  const key = last && sameKey(last);
  if (!last || !key) return null;
  let first = last;
  let n = 0;
  for (let i = calls.length - 1; i >= 0 && sameKey(calls[i] as T) === key; i--) {
    first = calls[i] as T;
    n++;
  }
  if (n < STREAK) return null;
  return {
    kind: 'repeat',
    params: { x: label(last), n },
    at: toolRef(last),
    since: first.startedAt,
  };
}

/** `STREAK` or more failed calls in a row at the end of an agent's finished calls. */
function failing(calls: Tool[]): TroubleSignal | null {
  const done = calls.filter((t) => t.status === 'complete' || t.status === 'error');
  let n = 0;
  while (n < done.length && done[done.length - 1 - n]?.status === 'error') n++;
  if (n < STREAK) return null;
  const last = done.at(-1) as Tool;
  const first = done[done.length - n] as Tool;
  return { kind: 'failing', params: { n }, at: toolRef(last), since: first.startedAt };
}

/** `ERRORS` or more failed model calls among the last `ERROR_WINDOW`. */
function errors(requests: Request[]): TroubleSignal | null {
  const recent = requests.slice(-ERROR_WINDOW);
  const failed = recent.filter((r) => r.status === 'error');
  if (failed.length < ERRORS) return null;
  const last = failed.at(-1) as Request;
  return {
    kind: 'errors',
    params: { n: failed.length, of: recent.length },
    at: { kind: 'request', agentId: last.agentId, requestId: last.id },
    since: failed[0]?.startedAt ?? null,
  };
}

/** Each compaction is a request the context was compacted before. */
function compaction(requests: Request[]): TroubleSignal | null {
  const compacted = requests.filter((r) => r.compactedBefore);
  if (compacted.length < COMPACTIONS) return null;
  const last = compacted.at(-1) as Request;
  return {
    kind: 'compaction',
    params: { n: compacted.length },
    at: { kind: 'request', agentId: last.agentId, requestId: last.id },
    since: compacted[COMPACTIONS - 1]?.startedAt ?? null,
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

/** The agent's running prompt, when it has run past both bounds against its finished ones. */
function longTurn(turns: Prompt[], now: number): TroubleSignal | null {
  const running = turns.filter((t) => t.status === 'running' && t.endedAt === null).at(-1);
  const took = turns
    .filter((t) => t.endedAt !== null)
    .map((t) => ms(t.endedAt) - ms(t.startedAt))
    .filter((d) => d >= 0);
  if (!running || took.length === 0) return null;
  const elapsed = now - ms(running.startedAt);
  const m = median(took);
  if (!(elapsed > LONG_FACTOR * m && elapsed > LONG_MS)) return null;
  return {
    kind: 'long-turn',
    params: { median: m },
    at: { kind: 'turn', agentId: running.agentId, turnId: running.id },
    since: running.startedAt,
  };
}

/**
 * The signs of trouble of `agentId` and its sub-agents, strongest first; none: empty. A
 * sub-agent counts while it runs (one that finished is not stuck, however it ended); the agent
 * asked about counts always. `label` names a repeated call: what a row may show of it.
 */
export function detectTrouble<T extends Tool>(
  s: TroubleInput<T>,
  agentId: string,
  now: number,
  label: (tool: T) => string,
): TroubleSignal[] {
  const ids = agentSubtree(s.agents, agentId);
  const live = (id: string) => id === agentId || s.agents.get(id)?.status === 'running';
  const calls = new Map<string, T[]>();
  for (const t of s.toolCalls.values())
    if (ids.has(t.agentId) && live(t.agentId)) push(calls, t.agentId, t);
  const signals: TroubleSignal[] = [];
  const add = (signal: TroubleSignal | null) => {
    if (signal) signals.push(signal);
  };
  for (const list of calls.values()) {
    const ordered = byStart(list);
    add(repeat(ordered, label));
    add(failing(ordered));
  }
  const requests = byStart([...s.requests.values()].filter((r) => ids.has(r.agentId)));
  add(errors(requests));
  add(compaction(requests));

  const turns = byStart([...s.turns.values()].filter((t) => t.agentId === agentId));
  const prompt = turns.filter((t) => t.status === 'running' && t.endedAt === null).at(-1);
  if (s.session.live === 'busy') add(longTurn(turns, now));
  // Waiting is the session's; it is this agent's when the one it waits on is in its tree.
  const waiter = s.session.activity?.agentId ?? MAIN_AGENT_ID;
  if (s.session.live === 'waiting' && ids.has(waiter)) {
    const since = s.session.activity?.since ?? s.session.updatedAt;
    const tool = s.session.activity?.tool;
    const blocked = byStart(
      [...s.toolCalls.values()].filter(
        (t) => ids.has(t.agentId) && t.status === 'running' && t.name === tool,
      ),
    ).at(-1);
    if (now - ms(since) > WAIT_MS)
      add({
        kind: 'waiting',
        params: {},
        at: blocked
          ? toolRef(blocked)
          : prompt
            ? { kind: 'turn', agentId: prompt.agentId, turnId: prompt.id }
            : null,
        since,
      });
  }
  // By kind, then the latest first; a sign of no known start after those of one.
  const rank = (x: TroubleSignal) => TROUBLE_KINDS.indexOf(x.kind);
  const start = (x: TroubleSignal) => ms(x.since) || 0;
  return signals.sort((a, b) => rank(a) - rank(b) || start(b) - start(a));
}
