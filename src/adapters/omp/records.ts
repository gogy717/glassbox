/**
 * Normalises one oh-my-pi session JSONL line into the fields the parser reads.
 *
 * A session file (format version 3) starts with a fixed-width `title` slot that omp rewrites in
 * place, then the `session` header, then entries. Every entry has an `id` and a `parentId`: the
 * entries form a tree, and the conversation is the path from the root to the active leaf.
 * Messages are pi-agent-core `AgentMessage`s, written when they end, never while they stream.
 * None of this is a published schema, so every field is read defensively.
 */
import type { TokenUsage } from '../../core/model.js';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});

/**
 * Unix milliseconds or an ISO string → ISO; null when it is not a representable time. omp writes
 * entry `timestamp`s as ISO and message `timestamp` / `completedAt` as milliseconds.
 */
export function toIso(v: unknown): string | null {
  let ms: number | null = null;
  if (typeof v === 'string') ms = Date.parse(v);
  else if (typeof v === 'number' && Number.isFinite(v))
    ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  if (ms === null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  // Beyond ±8.64e15 ms a Date is invalid and toISOString() would throw.
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * pi-ai `Usage`: `input` is already the uncached slice (`totalTokens = input + output +
 * cacheRead + cacheWrite`), `reasoningTokens` is the thinking subset of `output`, and Anthropic
 * splits cache writes by TTL in `cttl`. `cost` and `premiumRequests` have no place in the model;
 * `orchestration` tokens (billed, outside the conversation) are left out.
 */
export function mapOmpUsage(raw: unknown): TokenUsage | null {
  if (!isObj(raw)) return null;
  const ttl = obj(raw.cttl);
  const server = obj(raw.server);
  const write5m = num(ttl.ephemeral5m) ?? 0;
  const write1h = num(ttl.ephemeral1h) ?? 0;
  return {
    input: num(raw.input) ?? 0,
    cacheRead: num(raw.cacheRead) ?? 0,
    cacheWrite: num(raw.cacheWrite) ?? write5m + write1h,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    output: num(raw.output) ?? 0,
    thinking: num(raw.reasoningTokens) ?? 0,
    webSearch: num(server.webSearch) ?? 0,
    webFetch: num(server.webFetch) ?? 0,
  };
}

/** JSON nesting kept when a value is too deep for JSON.stringify (5,000–8,000 levels). */
const JSON_DEPTH = 256;

/** JSON text of `value`, or of a copy cut off at JSON_DEPTH when it is too deep to serialise. */
export function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return JSON.stringify(cutOff(value, 0));
  }
}

function cutOff(value: unknown, depth: number): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= JSON_DEPTH) return '[nested too deep]';
  if (Array.isArray(value)) return value.map((v) => cutOff(v, depth + 1));
  const out: Obj = {};
  for (const [key, v] of Object.entries(value)) out[key] = cutOff(v, depth + 1);
  return out;
}

/** Text sits a few levels down at most; past this a value is not text this adapter shows. */
const TEXT_DEPTH = 64;

/** Visible text: a string, `{text}`, or a list of those. Images and other blocks are skipped. */
export function textOf(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (depth > TEXT_DEPTH) return '';
  if (Array.isArray(value))
    return value
      .map((part) => textOf(part, depth + 1))
      .filter((part) => part !== '')
      .join('\n');
  if (!isObj(value)) return '';
  if (value.type !== undefined && value.type !== 'text') return '';
  return typeof value.text === 'string' ? value.text : '';
}

/** Card-form titles, `<icon> <CODE>: <title>` (`🧪 FLAKY: Fix flaky park tests`). */
const CARD_TITLE = /^(\S+) ([A-Z0-9]{1,6}: \S.*)$/su;

/**
 * The title without its card icon. omp prefixes generated titles with an emoji or a Nerd Fonts
 * glyph for its terminal panes; a browser without that font shows the glyph as a box, and the
 * icon carries nothing the code after it does not.
 */
export function cleanTitle(value: unknown): string | null {
  const title = str(value)?.trim() ?? null;
  if (!title) return null;
  const card = CARD_TITLE.exec(title);
  const icon = card?.[1];
  // omp only reads an all-non-ASCII word as an icon; `A1 FIX: …` is a plain title.
  if (!icon || !card[2] || [...icon].some((c) => c.charCodeAt(0) < 0x80)) return title;
  return card[2];
}

/** The position of an entry in the session tree. */
export interface EntryNode {
  id: string;
  parentId: string | null;
  /**
   * Set on an entry written off the active branch (late usage, a result routed back to the
   * branch it started on): the leaf that stays active. Absent: the entry is the new leaf.
   */
  activeLeafId?: string | null;
  timestamp: string | null;
  /** omp build that wrote the entry. */
  version: string | null;
}

export type AssistantBlock =
  /** Null text: the provider sent the reasoning encrypted (or redacted) only. */
  | { kind: 'thinking'; text: string | null }
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; id: string; name: string; input: unknown };

export interface UserBody {
  kind: 'user';
  text: string;
  /** 'user' (a person) or 'agent' (another agent, an automation). */
  attribution: string | null;
  synthetic: boolean;
  at: string | null;
}

export interface AssistantBody {
  kind: 'assistant';
  provider: string | null;
  model: string | null;
  api: string | null;
  usage: TokenUsage | null;
  /** 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'. */
  stopReason: string | null;
  error: { message: string; status: number | null; retryAttempt: number | null } | null;
  /** When the call was sent. */
  startedAt: string | null;
  endedAt: string | null;
  ttftMs: number | null;
  blocks: AssistantBlock[];
}

/** A `task` result names the sub-agents it spawned, with their outcome once they finished. */
export interface SpawnedAgent {
  id: string;
  outcome: 'complete' | 'error' | 'interrupted' | null;
}

export interface ToolResultBody {
  kind: 'tool-result';
  toolCallId: string;
  toolName: string | null;
  text: string;
  isError: boolean;
  at: string | null;
  /** `artifact://<id>`: the full output omp saved when it cut this result short. */
  artifactId: string | null;
  spawned: SpawnedAgent[];
}

/** Input omp injected for the model (`custom_message`): a background result, a reminder, … */
export interface InjectedBody {
  kind: 'injected';
  customType: string | null;
  text: string;
  attribution: string | null;
  at: string | null;
}

export interface ModelChangeBody {
  kind: 'model-change';
  /** `provider/modelId`. */
  model: string | null;
}

export interface ThinkingChangeBody {
  kind: 'thinking-change';
  /** Null: thinking off. */
  level: string | null;
}

/** A model call that is not part of the transcript (an auto-thinking judge, a probe, …). */
export interface ModelUsageBody {
  kind: 'model-usage';
  purpose: string | null;
  provider: string | null;
  model: string | null;
  api: string | null;
  usage: TokenUsage | null;
  stopReason: string | null;
  errorMessage: string | null;
}

export interface SessionInitBody {
  kind: 'session-init';
  /** Agent definition, e.g. "task", "scout". */
  agent: string | null;
  task: string;
  systemPrompt: string[] | null;
  tools: string[] | null;
}

export interface ToolStartBody {
  kind: 'tool-start';
  toolCallId: string;
  at: string | null;
}

export type EntryBody =
  | UserBody
  | AssistantBody
  | ToolResultBody
  | InjectedBody
  | ModelChangeBody
  | ThinkingChangeBody
  | ModelUsageBody
  | SessionInitBody
  | ToolStartBody
  | { kind: 'compaction' }
  | { kind: 'title-change'; title: string | null }
  /** Known and not shown (credential pins, labels, prompt digests, extension state, …). */
  | { kind: 'skip' }
  | { kind: 'unknown'; type: string };

export type OmpRecord =
  | { kind: 'title-slot'; title: string | null; updatedAt: string | null }
  | {
      kind: 'header';
      id: string;
      cwd: string | null;
      startedAt: string | null;
      title: string | null;
      /** The parent's session file, on a sub-agent's or a fork's header. */
      parentSession: string | null;
    }
  | { kind: 'entry'; node: EntryNode; body: EntryBody }
  | { kind: 'unknown'; type: string }
  | { kind: 'invalid' };

/** Entry types read for nothing: never shown, never counted as unknown. */
const SKIP_ENTRIES = new Set([
  // A hash of the serving account. Identity, so never surfaced.
  'credential_pin',
  'label',
  'ttsr_injection',
  'mode_change',
  'service_tier_change',
  'branch_summary',
  'reset_boundary',
]);

/** `custom` entries (extension state) read for nothing. */
const SKIP_CUSTOM = new Set(['system-prompt-digest', 'session_exit']);

/** Message roles that are context for the model, not input or output of a call. */
const CONTEXT_ROLES = new Set([
  'developer',
  'bashExecution',
  'pythonExecution',
  'branchSummary',
  'compactionSummary',
  'fileMention',
]);

function blocksOf(content: unknown): AssistantBlock[] {
  if (!Array.isArray(content)) return [];
  const out: AssistantBlock[] = [];
  for (const item of content) {
    const block = obj(item);
    if (block.type === 'thinking') {
      out.push({ kind: 'thinking', text: str(block.thinking) });
    } else if (block.type === 'redactedThinking') {
      out.push({ kind: 'thinking', text: null });
    } else if (block.type === 'text') {
      const text = str(block.text);
      if (text) out.push({ kind: 'text', text });
    } else if (block.type === 'toolCall') {
      const id = str(block.id);
      if (id)
        out.push({
          kind: 'tool-call',
          id,
          name: str(block.name) ?? 'tool',
          input: block.arguments ?? {},
        });
    }
  }
  return out;
}

function assistant(message: Obj): AssistantBody {
  const errorText = str(message.errorMessage);
  const retry = obj(message.retryRecovery);
  return {
    kind: 'assistant',
    provider: str(message.provider),
    model: str(message.model),
    api: str(message.api),
    usage: mapOmpUsage(message.usage),
    stopReason: str(message.stopReason),
    error:
      errorText || message.stopReason === 'error'
        ? {
            message: errorText ?? 'error',
            status: num(message.errorStatus),
            retryAttempt: num(retry.attempt),
          }
        : null,
    startedAt: toIso(message.timestamp),
    endedAt: toIso(message.completedAt),
    ttftMs: num(message.ttft),
    blocks: blocksOf(message.content),
  };
}

/** Ids a `task` call names: single (`details.results`) and async (`details.progress`) runs. */
function spawnedBy(details: Obj): SpawnedAgent[] {
  const out = new Map<string, SpawnedAgent>();
  const progress = Array.isArray(details.progress) ? details.progress : [];
  for (const item of progress) {
    const id = str(obj(item).id);
    if (id && !out.has(id)) out.set(id, { id, outcome: null });
  }
  const results = Array.isArray(details.results) ? details.results : [];
  for (const item of results) {
    const row = obj(item);
    const id = str(row.id);
    if (!id) continue;
    const exit = num(row.exitCode);
    const outcome =
      row.aborted === true
        ? 'interrupted'
        : str(row.error) || (exit !== null && exit !== 0)
          ? 'error'
          : 'complete';
    out.set(id, { id, outcome });
  }
  return [...out.values()];
}

/** `details.meta` names the artifact holding the whole output of a truncated result. */
function artifactOf(details: Obj): string | null {
  const meta = obj(details.meta);
  const id =
    str(obj(meta.truncation).artifactId) ?? str(obj(obj(meta.limits).columnTruncated).artifactId);
  return id && /^\d+$/.test(id) ? id : null;
}

function toolResult(message: Obj): ToolResultBody | null {
  const toolCallId = str(message.toolCallId);
  if (!toolCallId) return null;
  const details = obj(message.details);
  return {
    kind: 'tool-result',
    toolCallId,
    toolName: str(message.toolName),
    text: textOf(message.content),
    isError: message.isError === true,
    at: toIso(message.timestamp),
    artifactId: artifactOf(details),
    spawned: message.toolName === 'task' ? spawnedBy(details) : [],
  };
}

function messageBody(raw: unknown, entryAt: string | null): EntryBody {
  const message = obj(raw);
  const role = str(message.role) ?? 'unknown';
  if (role === 'user') {
    return {
      kind: 'user',
      text: textOf(message.content),
      attribution: str(message.attribution),
      synthetic: message.synthetic === true,
      at: toIso(message.timestamp) ?? entryAt,
    };
  }
  if (role === 'assistant') return assistant(message);
  if (role === 'toolResult')
    return toolResult(message) ?? { kind: 'unknown', type: 'message:toolResult' };
  if (role === 'custom' || role === 'hookMessage') {
    return {
      kind: 'injected',
      customType: str(message.customType),
      text: textOf(message.content),
      attribution: str(message.attribution),
      at: toIso(message.timestamp) ?? entryAt,
    };
  }
  if (CONTEXT_ROLES.has(role)) return { kind: 'skip' };
  return { kind: 'unknown', type: `message:${role}` };
}

function stringList(value: unknown): string[] | null {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string');
}

function entryBody(type: string, row: Obj, at: string | null): EntryBody {
  if (type === 'message') return messageBody(row.message, at);
  if (type === 'custom_message') {
    return {
      kind: 'injected',
      customType: str(row.customType),
      text: textOf(row.content),
      attribution: str(row.attribution),
      at,
    };
  }
  if (type === 'model_change') return { kind: 'model-change', model: str(row.model) };
  if (type === 'thinking_level_change')
    return { kind: 'thinking-change', level: str(row.thinkingLevel) };
  if (type === 'model_usage') {
    return {
      kind: 'model-usage',
      purpose: str(row.purpose),
      provider: str(row.provider),
      model: str(row.model),
      api: str(row.api),
      usage: mapOmpUsage(row.usage),
      stopReason: str(row.stopReason),
      errorMessage: str(row.errorMessage),
    };
  }
  if (type === 'compaction') return { kind: 'compaction' };
  if (type === 'title_change') return { kind: 'title-change', title: cleanTitle(row.title) };
  if (type === 'session_init') {
    return {
      kind: 'session-init',
      agent: str(row.agent),
      task: typeof row.task === 'string' ? row.task : '',
      systemPrompt: stringList(row.systemPrompt),
      tools: stringList(row.tools),
    };
  }
  if (type === 'custom') {
    const customType = str(row.customType) ?? 'custom';
    if (customType === 'tool_execution_start') {
      const data = obj(row.data);
      const toolCallId = str(data.toolCallId);
      if (toolCallId) return { kind: 'tool-start', toolCallId, at: toIso(data.startedAt) ?? at };
    }
    if (SKIP_CUSTOM.has(customType)) return { kind: 'skip' };
    return { kind: 'unknown', type: `custom:${customType}` };
  }
  if (SKIP_ENTRIES.has(type)) return { kind: 'skip' };
  return { kind: 'unknown', type };
}

/** Never throws. A blank or non-JSON line is `invalid`. */
export function parseOmpLine(line: string): OmpRecord {
  if (line.trim() === '') return { kind: 'invalid' };
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return { kind: 'invalid' };
  }
  if (!isObj(raw)) return { kind: 'invalid' };
  const type = str(raw.type);
  if (!type) return { kind: 'invalid' };
  if (type === 'title') {
    return { kind: 'title-slot', title: cleanTitle(raw.title), updatedAt: toIso(raw.updatedAt) };
  }
  if (type === 'session') {
    const id = str(raw.id);
    if (!id) return { kind: 'unknown', type };
    return {
      kind: 'header',
      id,
      cwd: str(raw.cwd),
      startedAt: toIso(raw.timestamp),
      title: cleanTitle(raw.title),
      parentSession: str(raw.parentSession),
    };
  }
  const id = str(raw.id);
  // Without an id an entry has no place in the tree.
  if (!id) return { kind: 'unknown', type };
  const timestamp = toIso(raw.timestamp);
  const node: EntryNode = {
    id,
    parentId: str(raw.parentId),
    timestamp,
    version: str(obj(raw.runtime).version),
  };
  if (raw.activeLeafId === null || typeof raw.activeLeafId === 'string')
    node.activeLeafId = raw.activeLeafId;
  return { kind: 'entry', node, body: entryBody(type, raw, timestamp) };
}
