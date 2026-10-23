/**
 * What a live session is doing right now (`SessionSummary.activity`), worked out from the
 * entities a parser already has. Agent-neutral: every adapter passes its views and its live
 * state, so "Thinking" and "Running" mean the same for every agent, and the same as the call
 * and tool cards (an in-flight call, a running tool).
 */
import type { IsoTime, LiveState, ModelRequest, SessionActivity, ToolCall, Turn } from './model.js';
import { MAIN_AGENT_ID } from './model.js';

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

const MAX = 120;

/**
 * The start of `s` on one line, cut at MAX characters with "…", secrets masked and the home
 * directory shown as "~". Masking runs on the whole head before the cut, so a secret is masked
 * entire or not shown at all.
 */
function clip(s: string): string {
  // Only the start shows: collapse the whitespace of that, not of a megabyte of input.
  const head = s.slice(0, MAX * 4);
  const line = homeless(redact(head)).replace(/\s+/g, ' ').trim();
  return line.length > MAX || head.length < s.trimEnd().length ? `${line.slice(0, MAX)}…` : line;
}

const MASK = '•••';

/** Words that make a variable, flag, header or JSON key name a secret. */
const SECRET_NAME = String.raw`[\w-]*(?:token|secret|key|pass|pwd|auth|credential|cookie|session)[\w-]*`;

/**
 * Credentials a command line, code or a pattern can carry, masked in place: targets go to every
 * client in the session list. Each pattern is linear and runs on at most MAX * 4 characters.
 */
const SECRETS: [RegExp, string][] = [
  // GITHUB_TOKEN=ghp_…, --password=…, ?api_key=…: up to a space, quote or separator. Not a
  // reference ($GH_TOKEN, ${…}, JSX's key={…}), a regex escape (grep "key=\|…"), or a closing
  // quote ('^export API_KEY=' file): nothing secret shows there.
  [
    new RegExp(
      String.raw`\b(${SECRET_NAME})=(?![{$\\])(?:"[^"\s][^"]*"|'[^'\s][^']*'|[^\s"'&;|]+)`,
      'gi',
    ),
    `$1=${MASK}`,
  ],
  // {"token": "…"}
  [new RegExp(String.raw`("${SECRET_NAME}"\s*:\s*)"[^"]*"`, 'gi'), `$1"${MASK}"`],
  // -H "X-Api-Key: …", --header 'Cookie: …'
  [
    new RegExp(String.raw`((?:-H|--header)[\s=]*["']?${SECRET_NAME}\s*:\s*)[^"'\n]+`, 'gi'),
    `$1${MASK}`,
  ],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]+/g, `$1 ${MASK}`],
  // --password hunter2, --token …: the value as the next word.
  [
    /(--(?:password|passwd|token|secret|api-?key|access-token|auth-token|client-secret)\s+)[^\s"']+/gi,
    `$1${MASK}`,
  ],
  // curl -u user:pass
  [/((?:\s|^)(?:-u|--user)[\s=]+[^\s:"']+):[^\s"']+/g, `$1:${MASK}`],
  // mysql -phunter2 (psql's -p is the port).
  [/\b((?:mysql|mysqldump|mysqladmin|mariadb)\b[^|;&\n]*?\s-p)[^\s"']+/g, `$1${MASK}`],
  // https://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^/\s@]+@/gi, `$1:${MASK}@`],
  // Tokens known by their prefix: Anthropic and OpenAI, GitHub, GitLab, Slack, AWS, Google, xAI,
  // Stripe, and JWTs.
  [
    /\b(?:sk-[\w-]{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abprs]-[\w-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[\w-]{35}|xai-\w{20,}|[sr]k_(?:live|test)_\w{16,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g,
    MASK,
  ],
];

function redact(s: string): string {
  let out = s;
  for (const [re, to] of SECRETS) out = out.replace(re, to);
  return out;
}

/** The server's home directory. The web imports this module too (`thinkingSince`): no node:os. */
const HOME =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.HOME ??
  '';
const HOME_AT =
  HOME.length > 1
    ? new RegExp(`${HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/|$|[\\s"'])`, 'g')
    : null;

/** The home directory as "~", as a shell prompt shows it. */
function homeless(s: string): string {
  return HOME_AT ? s.replace(HOME_AT, '~') : s;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Obj, k: string): string | null => {
  const v = o[k];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
};

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const isUrl = (s: string) => /^https?:\/\//i.test(s);

/** A URL's host; null when it has none (file:, "user:pass@host/x" read as a scheme). */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return clip(url) || null;
  }
}

const SHELL_BIN = /(^|[\\/])((ba|z|da|k)?sh|pwsh|powershell)(\.exe)?$/i;

/** A shell call's command line: a string, or an argv such as Codex's ["bash", "-lc", "…"]. */
function command(input: Obj): string | null {
  const v = input.command ?? input.cmd;
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (!Array.isArray(v) || v.length === 0 || !v.every((a) => typeof a === 'string')) return null;
  const [bin = '', ...rest] = v as string[];
  if (rest.length >= 2 && SHELL_BIN.test(bin) && /^(-\w*c|-command)$/i.test(rest.at(-2) ?? ''))
    return rest.at(-1) ?? null;
  return v.join(' ');
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
 * What a tool call works on, as data for the UI's sentence: the command, the pattern, the host,
 * the file name, the patched files, the sub-agent's task or the question. Null rather than a
 * guess: the UI then names the tool alone.
 */
export function activityTarget(name: string, input: unknown): string | null {
  if (typeof input === 'string') {
    const files = patchFiles(input);
    if (files) return files;
    // Code to run, as Codex's exec takes it after an optional `// @exec: {…}` settings line.
    if (!/^\s*\{/.test(input)) return clip(input.replace(/^\s*\/\/ @exec:.*\n/, '')) || null;
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
  const line = command(input);
  if (line) return clip(line);
  const pattern = str(input, 'pattern') ?? str(input, 'query');
  if (pattern) return clip(pattern);
  const url = str(input, 'url');
  if (url) return hostOf(url);
  const path = PATH_KEYS.map((k) => str(input, k)).find(Boolean);
  if (path) return isUrl(path) ? hostOf(path) : clip(basename(path));
  const question = Array.isArray(input.questions) ? input.questions[0] : null;
  if (isObj(question) && str(question, 'question')) return clip(str(question, 'question') ?? '');
  const label = LABEL_KEYS.map((k) => str(input, k)).find(Boolean);
  return label ? clip(label) : null;
}
