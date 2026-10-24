/**
 * What a live session is doing right now (`SessionSummary.activity`), worked out from the
 * entities a parser already has. Agent-neutral: every adapter passes its views and its live
 * state, so "Thinking" and "Running" mean the same for every agent, and the same as the call
 * and tool cards (an in-flight call, a running tool).
 */
import { hostOf, summarizeCode, summarizeCommand } from './command-summary.js';
import type { IsoTime, LiveState, ModelRequest, SessionActivity, ToolCall, Turn } from './model.js';
import { MAIN_AGENT_ID } from './model.js';
import { redact, tildeHome } from './redact.js';

export interface ActivityInput {
  live: LiveState;
  /** Tool calls that may be running; any order. Only status 'running' counts. */
  toolCalls: Iterable<ToolCall>;
  /** Requests that may be in flight; any order. Only status 'in-flight' counts. */
  requests: Iterable<ModelRequest>;
  /** The main agent's latest turn, if any. */
  lastTurn: Turn | null;
  /** The session's last write, for the idle spell when no turn says when it ended. */
  updatedAt: IsoTime | null;
}

/** Null when the session is not live, or busy with nothing on record to say what at. */
export function sessionActivity(input: ActivityInput): SessionActivity | null {
  const { live, lastTurn } = input;
  if (live !== 'busy' && live !== 'waiting' && live !== 'idle') return null;
  // A step after the turn's end mark (work Claude Code resumed without a new turn) is later.
  if (live === 'idle') {
    if (!lastTurn) return idleActivity(input.updatedAt);
    return idleActivity(latest(lastTurn.endedAt, lastStep(input, lastTurn)));
  }

  const calls = [...input.requests].filter((r) => r.status === 'in-flight');
  let call: ModelRequest | null = null;
  for (const r of calls) if (later(r, call)) call = r;
  const tool = runningTool(input.toolCalls, calls);
  if (live === 'waiting') {
    return {
      kind: 'waiting',
      tool: tool?.name ?? null,
      target: tool ? activityTarget(tool.name, tool.input) : null,
      agentId: tool?.agentId ?? MAIN_AGENT_ID,
      since: tool?.startedAt ?? null,
    };
  }
  // A sub-agent's newer step wins over the main agent's Agent tool that waits on it.
  if (tool && !(call && later(call, tool))) {
    return {
      kind: 'tool',
      tool: tool.name,
      target: activityTarget(tool.name, tool.input),
      agentId: tool.agentId,
      since: tool.startedAt,
    };
  }
  if (call) {
    return {
      kind: call.blocks.at(-1)?.kind === 'text' ? 'writing' : 'thinking',
      tool: null,
      target: null,
      agentId: call.agentId,
      since: thinkingSince(call, input.toolCalls),
    };
  }
  // Busy mid-turn with nothing running: the model is on its next step, which agents that write
  // a call only once it is answered have not recorded yet.
  if (lastTurn?.status !== 'running') return null;
  return {
    kind: 'thinking',
    tool: null,
    target: null,
    agentId: MAIN_AGENT_ID,
    since: lastStep(input, lastTurn),
  };
}

/** `sessionActivity` as a summary's optional field: spread it in, absent when null. */
export function activityField(input: ActivityInput): { activity?: SessionActivity } {
  const activity = sessionActivity(input);
  return activity ? { activity } : {};
}

/** An agent's latest turn among `turns`, by index. */
export function latestTurn(turns: Iterable<Turn>, agentId = MAIN_AGENT_ID): Turn | null {
  let last: Turn | null = null;
  for (const t of turns)
    if (t.agentId === agentId && (last === null || t.index > last.index)) last = t;
  return last;
}

/** Between turns since `since`: the whole activity of an idle session. */
export function idleActivity(since: IsoTime | null): SessionActivity {
  return { kind: 'idle', tool: null, target: null, agentId: MAIN_AGENT_ID, since };
}

/**
 * Where a call in flight's "Thinking · m:ss" clock starts: at its last step, the end of the
 * latest of its own tools, else the call's start. A call that spans its tools (Codex, Grok,
 * OpenCode) would otherwise jump back to its start once a tool ends. `tools` may hold others.
 */
export function thinkingSince(call: ModelRequest, tools: Iterable<ToolCall>): IsoTime | null {
  const own = new Set(call.toolCallIds);
  let since = call.startedAt;
  for (const t of tools) if (own.has(t.id)) since = latest(since, t.endedAt);
  return since;
}

/** Epoch ms of `t`; -Infinity when unknown or unreadable, so it sorts first. */
const ms = (t: IsoTime | null): number => {
  const v = t === null ? Number.NaN : Date.parse(t);
  return Number.isNaN(v) ? Number.NEGATIVE_INFINITY : v;
};

/** The later of two times, by instant: "…:05Z" and "…:04.900Z" do not compare as text. */
function latest<T extends IsoTime | null>(a: T, b: IsoTime | null): T | IsoTime {
  return b !== null && ms(b) > ms(a) ? b : a;
}

/**
 * The running tool that started last, with its start. A tool that a call still in flight asked
 * for and that has not ended is running too, timed from that ask: Codex knows neither status
 * nor start of a tool until its output lands, and keeps the call open until then.
 */
function runningTool(tools: Iterable<ToolCall>, calls: ModelRequest[]): ToolCall | null {
  const asked = new Map<string, IsoTime>();
  for (const r of calls)
    for (const b of r.blocks) if (b.kind === 'tool-use') asked.set(b.toolCallId, b.at);
  let found: ToolCall | null = null;
  for (const t of tools) {
    const ask = asked.get(t.id);
    const open =
      t.status === 'running' || (t.status === 'unknown' && t.endedAt === null && ask !== undefined);
    if (!open) continue;
    const timed = t.startedAt === null && ask !== undefined ? { ...t, startedAt: ask } : t;
    if (later(timed, found)) found = timed;
  }
  return found;
}

/** Whether `a` started after `b`; an unknown start counts as earliest. */
function later(a: { startedAt: IsoTime | null }, b: { startedAt: IsoTime | null } | null): boolean {
  return b === null || ms(a.startedAt) > ms(b.startedAt);
}

/** When the turn's last step ended: its agent's latest call or tool end, else the turn's start. */
function lastStep(input: ActivityInput, turn: Turn): IsoTime {
  let since: IsoTime = turn.startedAt;
  for (const r of input.requests) if (r.agentId === turn.agentId) since = latest(since, r.endedAt);
  for (const t of input.toolCalls) if (t.agentId === turn.agentId) since = latest(since, t.endedAt);
  return since;
}

// ── Targets ───────────────────────────────────────────────────────────────────────────────

/** Targets are data for a one-line sentence: a name, a pattern, a task. */
const MAX = 120;
/** A command's summary: a program, its subcommand or script, a host, a count. */
const COMMAND_MAX = 60;

/**
 * The start of `s` on one line, cut at `max` characters with "…", credentials masked and the
 * home directory shown as "~". Masking runs before the cut and on whole words: a word that the
 * head's end would split is left out, so no part of a credential shows whose whole would have
 * been masked.
 */
function clip(s: string, max = MAX): string {
  // Only the start shows: collapse the whitespace of that, not of a megabyte of input.
  let head = s.slice(0, max * 4);
  if (head.length < s.length && /\S/.test(s[head.length] ?? '')) {
    const whole = head.replace(/\S+$/, '');
    if (whole.trim() !== '') head = whole;
  }
  const line = tildeHome(redact(head)).replace(/\s+/g, ' ').trim();
  return line.length > max || head.length < s.trimEnd().length ? `${line.slice(0, max)}…` : line;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Obj, k: string): string | null => {
  const v = o[k];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
};

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const isUrl = (s: string) => /^https?:\/\//i.test(s);

/**
 * A URL's host, read with a scheme when it has none (`api.x.io/v1?token=…`); null when it has
 * no host (file:, "user:pass@host/x" read as a scheme). Never the URL itself.
 */
function host(url: string): string | null {
  const h = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? hostOf(url) : hostOf(`https://${url}`);
  return h && clip(h);
}

/** A file's name, or "~" for the home directory itself. */
const fileName = (path: string) => clip(basename(tildeHome(path.trim())));

/**
 * A shell call's command, a string or an argv such as Codex's ["bash", "-lc", "…"], as its
 * summary: never the command line, which can carry anything. Undefined when there is none.
 */
function commandTarget(name: string, input: Obj): string | null | undefined {
  const v = input.command ?? input.cmd;
  let line: string | unknown[] | null = null;
  if (typeof v === 'string' && v.trim() !== '') line = v;
  // An argv is read only as far as the summary reads it, however long.
  else if (Array.isArray(v) && typeof v[0] === 'string') line = v;
  if (line === null) return undefined;
  const summary = summarizeCommand(line, { powershell: /powershell|pwsh/i.test(name) });
  return summary === null ? null : clip(summary, COMMAND_MAX);
}

/** The files a patch touches (`*** Update File: src/a.ts`), by name. */
function patchFiles(patch: string): string | null {
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) =>
    basename((m[1] ?? '').trim()),
  );
  return files.length > 0 ? clip(files.join(', ')) : null;
}

/** Where a file lives, whatever the agent calls the key. */
const PATH_KEYS = [
  'file_path',
  'filePath',
  'path',
  'target_file',
  'notebook_path',
  'target_notebook',
  'dir_path',
  'target_directory',
];
/**
 * What a call says it is for or works on: a sub-agent's task, oh-my-pi's intent (`i`), a page's
 * title, a skill, a message's summary.
 */
const LABEL_KEYS = ['description', 'task_name', 'i', 'title', 'skill', 'summary'];

/** Past this, string input is not worth parsing for a target. */
const PARSE_MAX = 100_000;

/**
 * What a tool call works on, as data for the UI's sentence: a command's summary, the pattern,
 * the host, the file name, the patched files, the sub-agent's task or the question. Null rather
 * than a guess: the UI then names the tool alone.
 */
export function activityTarget(name: string, input: unknown): string | null {
  if (typeof input === 'string') {
    const files = patchFiles(input);
    if (files) return files;
    // Code to run, as Codex's exec takes it: named by the commands it hands to tools.
    if (!/^\s*\{/.test(input)) {
      const summary = summarizeCode(input);
      return summary === null ? null : clip(summary, COMMAND_MAX);
    }
    // Arguments still arriving or that did not parse (OpenCode's pending raw input).
    if (input.length > PARSE_MAX) return null;
    try {
      const parsed: unknown = JSON.parse(input);
      return isObj(parsed) ? activityTarget(name, parsed) : null;
    } catch {
      return null;
    }
  }
  if (!isObj(input)) return null;
  const patch = str(input, 'input') ?? str(input, 'patchText');
  if (patch && /^\*\*\* Begin Patch/m.test(patch)) return patchFiles(patch);
  const command = commandTarget(name, input);
  if (command !== undefined) return command;
  const pattern = str(input, 'pattern') ?? str(input, 'query');
  if (pattern) return clip(pattern);
  const url = str(input, 'url');
  if (url) return host(url);
  const path = PATH_KEYS.map((k) => str(input, k)).find(Boolean);
  if (path) return isUrl(path) ? host(path) : fileName(path);
  const question = Array.isArray(input.questions) ? input.questions[0] : null;
  if (isObj(question) && str(question, 'question')) return clip(str(question, 'question') ?? '');
  const label = LABEL_KEYS.map((k) => str(input, k)).find(Boolean);
  return label ? clip(label) : null;
}
