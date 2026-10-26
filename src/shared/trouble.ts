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
  TroubleKind,
  TroubleRef,
  TroubleSignal,
  Turn,
} from '../core/model.js';
import { MAIN_AGENT_ID } from '../core/model.js';
import { SHELL_TOOLS, shellCommand } from './tool-category.js';

export type { TroubleKind, TroubleRef, TroubleSignal };

/** Strongest first: the order in which the summary bar lists them, and the server picks one. */
export const TROUBLE_KINDS: readonly TroubleKind[] = [
  'repeat',
  'failing',
  'errors',
  'waiting',
  'long-turn',
  'compaction',
];

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

/** A call that is a look while waiting, not an attempt: streaks look past it. */
const POLL = Symbol('poll');

/**
 * What makes two calls the same call: a shell command by its line, whitespace aside (the line
 * the call's summary shows, whole); any other tool by its name and its input. `POLL` for a call
 * that repeats by nature, a poll, a wait, a `sleep` before a look; null for one that is never
 * the same as another.
 */
function sameKey(tool: Tool): string | null | typeof POLL {
  if (POLLING.has(tool.name)) return POLL;
  const line = SHELL_TOOLS.has(tool.name) ? shellCommand(tool.input) : null;
  if (line !== null)
    return /^\s*sleep\s/.test(line) ? POLL : `$ ${line.replace(/\s+/g, ' ').trim()}`;
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

/**
 * An agent's model steps in the prompt it runs, oldest first, each the calls one request asked
 * for: calls asked for together are one attempt, not a streak. A call of a request an earlier
 * prompt made is left out (you asking for the tests again is not the agent stuck); one whose
 * request names no prompt is kept, so an agent whose calls know no prompt is read across them.
 */
function stepsOf<T extends Tool>(calls: T[], s: TroubleInput<T>, prompt: string | null): T[][] {
  const steps = new Map<string, T[]>();
  for (const t of byStart(calls)) {
    const turnId = s.requests.get(t.requestId)?.turnId ?? null;
    if (turnId === null || turnId === prompt) push(steps, t.requestId, t);
  }
  return [...steps.values()];
}

/** What makes a step the same as another: its attempts' keys; `POLL` when it only looked. */
function stepKey(step: Tool[]): string | null | typeof POLL {
  const keys = step.map(sameKey).filter((k) => k !== POLL);
  if (keys.length === 0) return POLL;
  return keys.includes(null) ? null : (keys as string[]).sort().join('\n');
}

/** The same step `STREAK` or more times in a row at the end of an agent's, polls looked past. */
function repeat<T extends Tool>(steps: T[][], label: (tool: T) => string): TroubleSignal | null {
  const keyed = steps.map((step) => ({ step, key: stepKey(step) })).filter((x) => x.key !== POLL);
  const last = keyed.at(-1);
  if (!last || last.key === null) return null;
  let n = 0;
  while (n < keyed.length && keyed[keyed.length - 1 - n]?.key === last.key) n++;
  if (n < STREAK) return null;
  const call = last.step.filter((t) => sameKey(t) !== POLL).at(-1) as T;
  const first = keyed[keyed.length - n]?.step[0] as T;
  return {
    kind: 'repeat',
    params: { x: label(call), n },
    at: toolRef(call),
    since: first.startedAt,
  };
}

/**
 * `STREAK` or more failed steps in a row at the end of an agent's finished ones: a step failed
 * when every call of it that finished failed; one still running is not over yet. `n` counts the
 * calls that failed.
 */
function failing(steps: Tool[][]): TroubleSignal | null {
  let failed = 0;
  let n = 0;
  let first: Tool | undefined;
  let last: Tool | undefined;
  for (let i = steps.length - 1; i >= 0; i--) {
    const done = (steps[i] as Tool[]).filter(
      (t) => t.status === 'complete' || t.status === 'error',
    );
    if (done.length === 0) continue;
    if (!done.every((t) => t.status === 'error')) break;
    failed++;
    n += done.length;
    last ??= done.at(-1);
    first = done[0];
  }
  if (failed < STREAK || !first || !last) return null;
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
 * sub-agent counts while it runs (one that finished is not stuck, however it ended, its calls
 * and its model calls alike); the agent asked about counts always. Streaks count model steps
 * within the prompt each agent runs (`stepsOf`). `label` names a repeated call: what a row may
 * show of it.
 */
export function detectTrouble<T extends Tool>(
  s: TroubleInput<T>,
  agentId: string,
  now: number,
  label: (tool: T) => string,
): TroubleSignal[] {
  const ids = agentSubtree(s.agents, agentId);
  const live = (id: string) =>
    ids.has(id) && (id === agentId || s.agents.get(id)?.status === 'running');
  const calls = new Map<string, T[]>();
  for (const t of s.toolCalls.values()) if (live(t.agentId)) push(calls, t.agentId, t);
  // The prompt each agent runs, its latest: streaks are within it.
  const prompts = new Map<string, string>();
  for (const t of byStart([...s.turns.values()]))
    if (t.status === 'running' && t.endedAt === null) prompts.set(t.agentId, t.id);
  const signals: TroubleSignal[] = [];
  const add = (signal: TroubleSignal | null) => {
    if (signal) signals.push(signal);
  };
  for (const [id, list] of calls) {
    const steps = stepsOf(list, s, prompts.get(id) ?? null);
    add(repeat(steps, label));
    add(failing(steps));
  }
  const requests = byStart([...s.requests.values()].filter((r) => live(r.agentId)));
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
