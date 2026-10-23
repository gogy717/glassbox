/**
 * Normalises OpenCode's database rows into the fields the parser reads.
 *
 * OpenCode 1.x keeps sessions in SQLite. A `session` row with `parent_id` set is a sub-agent
 * the `task` tool started. A `message` row's JSON `data` is a user or an assistant message;
 * an assistant message is one model call (older builds put several steps in one). A `part`
 * row's JSON `data` is one piece of a message: text, reasoning, a tool call with its state, a
 * step boundary with that step's token usage, and a few more. None of it is a public schema,
 * so every field is read defensively.
 */
import type { TokenUsage } from '../../core/model.js';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});

/** A `session` row as discovery and the adapter read it (the columns glassbox uses). */
export interface SessionRow {
  id: string;
  parent_id: string | null;
  title: string;
  directory: string;
  version: string;
  agent: string | null;
  /** JSON `{ id, providerID, variant }`. */
  model: string | null;
  time_created: number;
  time_updated: number;
  time_compacting: number | null;
  time_archived: number | null;
}

export interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

/** One root session and every session below it, as the adapter hands it to the parser. */
export interface SessionDocument {
  sessions: SessionRow[];
  messages: MessageRow[];
  parts: PartRow[];
}

/** The document's three row lists, or null when `value` is not one (rows are checked later). */
export function asDocument(
  value: unknown,
): { sessions: unknown[]; messages: unknown[]; parts: unknown[] } | null {
  if (!isObj(value)) return null;
  const { sessions, messages, parts } = value;
  if (!Array.isArray(sessions) || !Array.isArray(messages) || !Array.isArray(parts)) return null;
  return { sessions, messages, parts };
}

export function isMessageRow(row: unknown): row is MessageRow {
  return (
    isObj(row) &&
    typeof row.id === 'string' &&
    typeof row.session_id === 'string' &&
    typeof row.data === 'string'
  );
}

export function isPartRow(row: unknown): row is PartRow {
  return isMessageRow(row) && typeof (row as unknown as Obj).message_id === 'string';
}

/** Epoch milliseconds (OpenCode's only time format) → ISO; null when not a representable time. */
export function toIso(v: unknown): string | null {
  const ms = num(v);
  if (ms === null) return null;
  const d = new Date(ms);
  // Beyond ±8.64e15 ms a Date is invalid and toISOString() would throw.
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * OpenCode splits usage the way glassbox does except for output: its `input` is already the
 * uncached slice (cache read and write are subtracted when it records a step), but its `output`
 * leaves reasoning out, which glassbox counts as part of output.
 */
export function mapTokens(raw: unknown): TokenUsage | null {
  if (!isObj(raw)) return null;
  const cache = obj(raw.cache);
  const reasoning = num(raw.reasoning) ?? 0;
  return {
    input: num(raw.input) ?? 0,
    cacheRead: num(cache.read) ?? 0,
    cacheWrite: num(cache.write) ?? 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: (num(raw.output) ?? 0) + reasoning,
    thinking: reasoning,
    webSearch: 0,
    webFetch: 0,
  };
}

/** What OpenCode names a session before a title is generated: no title yet. */
const PLACEHOLDER_TITLE =
  /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The `task` tool titles a sub-agent's session "<description> (@<agent> subagent)". */
const SUBAGENT_SUFFIX = /\s*\(@[^()]+ subagent\)$/;

export interface SessionInfo {
  id: string;
  parentId: string | null;
  /** Null while OpenCode still shows its placeholder. */
  title: string | null;
  /** A sub-agent session's title without the "(@agent subagent)" suffix. */
  label: string | null;
  directory: string | null;
  version: string | null;
  /** OpenCode agent the session runs as, e.g. "build", "explore". */
  agent: string | null;
  model: string | null;
  createdAt: string | null;
  updatedMs: number | null;
}

export function parseSessionRow(row: unknown): SessionInfo | null {
  const r = obj(row);
  const id = str(r.id);
  if (!id) return null;
  const rawTitle = str(r.title);
  const title = rawTitle && !PLACEHOLDER_TITLE.test(rawTitle) ? rawTitle : null;
  let model: Obj = {};
  if (typeof r.model === 'string') {
    try {
      model = obj(JSON.parse(r.model));
    } catch {
      // A torn model column costs the fallback model name, nothing else.
    }
  }
  return {
    id,
    parentId: str(r.parent_id),
    title,
    label: title ? str(title.replace(SUBAGENT_SUFFIX, '')) : null,
    directory: str(r.directory),
    version: str(r.version),
    agent: str(r.agent),
    model: str(model.id),
    createdAt: toIso(r.time_created),
    updatedMs: num(r.time_updated),
  };
}

export interface MessageError {
  name: string;
  message: string;
  status: number | null;
  /** The user (or OpenCode) stopped the call: an interruption, not a failure. */
  aborted: boolean;
}

export interface UserMessage {
  kind: 'user';
  id: string;
  sessionId: string;
  createdMs: number | null;
}

export interface AssistantMessage {
  kind: 'assistant';
  id: string;
  sessionId: string;
  /** The user message this call answers. */
  parentId: string | null;
  createdMs: number | null;
  completedMs: number | null;
  model: string | null;
  provider: string | null;
  agent: string | null;
  /** Provider-specific reasoning effort ("low", "max", …); null for the model's default. */
  variant: string | null;
  finish: string | null;
  /** This call wrote a compaction summary: the next call starts from it. */
  summary: boolean;
  tokens: TokenUsage | null;
  error: MessageError | null;
}

export interface OtherRecord {
  kind: 'other';
  type: string;
  known: boolean;
}

export type OpenCodeMessage = UserMessage | AssistantMessage | OtherRecord | { kind: 'invalid' };

function jsonData(data: unknown): Obj | null {
  if (typeof data !== 'string') return null;
  try {
    const value: unknown = JSON.parse(data);
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
}

function messageError(raw: unknown): MessageError | null {
  if (!isObj(raw)) return null;
  const name = str(raw.name) ?? 'Error';
  const data = obj(raw.data);
  return {
    name,
    message: str(data.message) ?? name,
    status: num(data.statusCode),
    aborted: name === 'MessageAbortedError',
  };
}

export function parseMessageRow(row: MessageRow): OpenCodeMessage {
  const data = jsonData(row.data);
  if (!data) return { kind: 'invalid' };
  const time = obj(data.time);
  const createdMs = num(time.created) ?? num(row.time_created);
  if (data.role === 'user') {
    return { kind: 'user', id: row.id, sessionId: row.session_id, createdMs };
  }
  if (data.role === 'assistant') {
    const variant = str(data.variant);
    return {
      kind: 'assistant',
      id: row.id,
      sessionId: row.session_id,
      parentId: str(data.parentID),
      createdMs,
      completedMs: num(time.completed),
      model: str(data.modelID),
      provider: str(data.providerID),
      agent: str(data.agent) ?? str(data.mode),
      variant: variant === 'default' ? null : variant,
      finish: str(data.finish),
      summary: data.summary === true,
      tokens: mapTokens(data.tokens),
      error: messageError(data.error),
    };
  }
  return { kind: 'other', type: `message:${str(data.role) ?? 'unknown'}`, known: false };
}

export interface TextPart {
  kind: 'text';
  text: string;
  /** Injected by OpenCode (e.g. a background task's result), not typed by anyone. */
  synthetic: boolean;
  startMs: number | null;
  endMs: number | null;
}

export interface ReasoningPart {
  kind: 'reasoning';
  text: string;
  startMs: number | null;
  endMs: number | null;
}

export interface ToolPart {
  kind: 'tool';
  callId: string | null;
  tool: string;
  /** "pending" | "running" | "completed" | "error". */
  status: string | null;
  input: unknown;
  output: string | null;
  error: string | null;
  startMs: number | null;
  endMs: number | null;
  /** The sub-agent session a `task` call runs in. */
  childSessionId: string | null;
}

export interface StepStartPart {
  kind: 'step-start';
}

export interface StepFinishPart {
  kind: 'step-finish';
  reason: string | null;
  tokens: TokenUsage | null;
}

export interface SubtaskPart {
  kind: 'subtask';
  prompt: string;
}

export interface CompactionPart {
  kind: 'compaction';
}

/** Common to every part: where it belongs and when its row was written. */
export interface PartBase {
  id: string;
  messageId: string;
  sessionId: string;
  createdMs: number | null;
}

export type OpenCodePart = PartBase &
  (
    | TextPart
    | ReasoningPart
    | ToolPart
    | StepStartPart
    | StepFinishPart
    | SubtaskPart
    | CompactionPart
    | OtherRecord
    | { kind: 'invalid' }
  );

/** Parts glassbox has no view for: attachments, snapshots, patches, retries, @agent mentions. */
const KNOWN_PARTS = new Set(['file', 'agent', 'snapshot', 'patch', 'retry']);

export function parsePartRow(row: PartRow): OpenCodePart {
  const base: PartBase = {
    id: row.id,
    messageId: row.message_id,
    sessionId: row.session_id,
    createdMs: num(row.time_created),
  };
  const data = jsonData(row.data);
  if (!data) return { ...base, kind: 'invalid' };
  const type = str(data.type) ?? 'unknown';
  const time = obj(data.time);
  if (type === 'text') {
    return {
      ...base,
      kind: 'text',
      text: typeof data.text === 'string' ? data.text : '',
      synthetic: data.synthetic === true,
      startMs: num(time.start),
      endMs: num(time.end),
    };
  }
  if (type === 'reasoning') {
    return {
      ...base,
      kind: 'reasoning',
      text: typeof data.text === 'string' ? data.text : '',
      startMs: num(time.start),
      endMs: num(time.end),
    };
  }
  if (type === 'tool') {
    const state = obj(data.state);
    const stateTime = obj(state.time);
    const status = str(state.status);
    return {
      ...base,
      kind: 'tool',
      callId: str(data.callID),
      tool: str(data.tool) ?? 'tool',
      status,
      // A pending call has only the raw argument text so far.
      input: state.input ?? (typeof state.raw === 'string' ? state.raw : {}),
      output: typeof state.output === 'string' ? state.output : null,
      error: typeof state.error === 'string' ? state.error : null,
      startMs: num(stateTime.start),
      endMs: num(stateTime.end),
      childSessionId: str(obj(state.metadata).sessionId),
    };
  }
  if (type === 'step-start') return { ...base, kind: 'step-start' };
  if (type === 'step-finish') {
    return {
      ...base,
      kind: 'step-finish',
      reason: str(data.reason),
      tokens: mapTokens(data.tokens),
    };
  }
  if (type === 'subtask') {
    return { ...base, kind: 'subtask', prompt: str(data.prompt) ?? str(data.description) ?? '' };
  }
  if (type === 'compaction') return { ...base, kind: 'compaction' };
  return { ...base, kind: 'other', type: `part:${type}`, known: KNOWN_PARTS.has(type) };
}
