/**
 * Normalises one Codex rollout JSONL line into the fields the parser reads.
 *
 * A rollout line is `{ timestamp, ordinal, type, payload }`. Two parallel streams describe the
 * same turn: `response_item` is the model transcript and `event_msg` / `item_completed` is the
 * app item (timings and status). Reasoning text is an encrypted blob; only `summary` is readable.
 */
import type { TokenUsage } from '../../core/model.js';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Unix seconds, unix milliseconds, or an ISO string → ISO; null when it is not a representable
 * time. Codex mixes all three (record `timestamp` ISO, `started_at` seconds, `*_at_ms` ms).
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

const USAGE_FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
] as const;

/**
 * Codex `token_usage_record.usage` and `token_count.info.last_token_usage` share one shape.
 * `input_tokens` is the whole prompt (it was never below `cached_input_tokens` in 1,588 local
 * usage objects), so uncached input is `input_tokens - cached_input_tokens`.
 * `cache_write_input_tokens` is the only cache-write figure — there is no 5-minute / 1-hour
 * split. `reasoning_output_tokens` is the thinking subset of `output_tokens`. Web search is an Extension item, not a counter on this object.
 * Cumulative `total_token_usage` / `turn_token_usage` / `thread_token_usage` must not be passed
 * here: summing them with per-response usage double-counts the session.
 */
export function mapCodexUsage(raw: unknown): TokenUsage | null {
  if (!isObj(raw)) return null;
  if (!USAGE_FIELDS.some((key) => num(raw[key]) !== null)) return null;
  const inputTokens = num(raw.input_tokens) ?? 0;
  const cached = num(raw.cached_input_tokens) ?? 0;
  const uncached = inputTokens - cached;
  return {
    input: uncached >= 0 ? uncached : inputTokens,
    cacheRead: cached,
    cacheWrite: num(raw.cache_write_input_tokens) ?? 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: num(raw.output_tokens) ?? 0,
    thinking: num(raw.reasoning_output_tokens) ?? 0,
    webSearch: 0,
    webFetch: 0,
  };
}

/** Text sits a few levels down at most; past this a value is not text this adapter shows. */
const TEXT_DEPTH = 64;

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

/** Visible text. Accepts a string, `{text}`, or a list of those. Does not read encrypted blobs. */
export function textOf(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (depth > TEXT_DEPTH) return '';
  if (Array.isArray(value))
    return value
      .map((part) => textOf(part, depth + 1))
      .filter((part) => part !== '')
      .join('');
  if (!isObj(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) return textOf(value.content, depth + 1);
  if (typeof value.aggregated_output === 'string') return value.aggregated_output;
  if (typeof value.output === 'string') return value.output;
  if (Array.isArray(value.output)) return textOf(value.output, depth + 1);
  return '';
}

function parseJsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export interface SessionMetaRecord {
  kind: 'session-meta';
  id: string;
  cwd: string | null;
  startedAt: string | null;
  version: string | null;
  parentThreadId: string | null;
  agentType: string | null;
  label: string | null;
  system: string | null;
  /**
   * In a sub-agent's rollout, records with a lower ordinal are a copy of the parent's history
   * up to the spawn, not the child's own work.
   */
  historyStart: number | null;
  timestamp: string | null;
  ordinal: number;
}

export interface TaskStartedRecord {
  kind: 'task-started';
  turnId: string;
  startedAt: string | null;
  trigger: string | null;
  timestamp: string | null;
  ordinal: number;
}

export interface TaskCompleteRecord {
  kind: 'task-complete';
  turnId: string;
  endedAt: string | null;
  errorMessage: string | null;
  timestamp: string | null;
  ordinal: number;
}

export interface TurnAbortedRecord {
  kind: 'turn-aborted';
  turnId: string | null;
  timestamp: string | null;
  ordinal: number;
}

export interface TurnContextRecord {
  kind: 'turn-context';
  turnId: string | null;
  model: string | null;
  effort: string | null;
  timestamp: string | null;
  ordinal: number;
}

export interface UsageRecord {
  kind: 'usage';
  responseId: string;
  turnId: string | null;
  usage: TokenUsage;
  timestamp: string | null;
  ordinal: number;
}

export interface TokenCountRecord {
  kind: 'token-count';
  usage: TokenUsage | null;
  /**
   * Identity of the thread's cumulative `total_token_usage` (`cumulative`), else of
   * `last_token_usage`. An unchanged total means no tokens were spent: a rebroadcast (rate-limit
   * update) or the context size rewritten after compaction, never a call.
   */
  usageKey: string | null;
  cumulative: boolean;
  timestamp: string | null;
  ordinal: number;
}

export interface ReasoningRecord {
  kind: 'reasoning';
  turnId: string | null;
  text: string | null;
  timestamp: string | null;
  ordinal: number;
}

export interface UserTextRecord {
  kind: 'user-text';
  turnId: string | null;
  text: string;
  timestamp: string | null;
  ordinal: number;
}

export interface AssistantTextRecord {
  kind: 'assistant-text';
  turnId: string | null;
  text: string;
  timestamp: string | null;
  ordinal: number;
}

export interface DeveloperTextRecord {
  kind: 'developer-text';
  turnId: string | null;
  ordinal: number;
}

export interface AgentMessageRecord {
  kind: 'agent-message';
  turnId: string | null;
  text: string;
  timestamp: string | null;
  ordinal: number;
}

export interface ToolCallRecord {
  kind: 'tool-call';
  callId: string;
  name: string;
  input: unknown;
  /** `completed` / `failed` when the call record itself carries a status. */
  status: string | null;
  turnId: string | null;
  timestamp: string | null;
  ordinal: number;
}

export interface ToolOutputRecord {
  kind: 'tool-output';
  callId: string;
  output: unknown;
  turnId: string | null;
  timestamp: string | null;
  ordinal: number;
}

export interface ItemRecord {
  kind: 'item';
  itemType: string;
  itemId: string | null;
  status: string | null;
  isError: boolean;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  outputText: string | null;
  text: string | null;
  agentThreadId: string | null;
  agentPath: string | null;
  activityKind: string | null;
  known: boolean;
  timestamp: string | null;
  ordinal: number;
}

export interface ToolsRecord {
  kind: 'tools';
  tools: unknown[];
  ordinal: number;
}

export interface CompactedRecord {
  kind: 'compacted';
  timestamp: string | null;
  ordinal: number;
}

export interface SkipRecord {
  kind: 'skip';
  type: string;
  ordinal?: number;
}

export interface UnknownRecord {
  kind: 'unknown';
  type: string;
  ordinal?: number;
}

export interface InvalidRecord {
  kind: 'invalid';
}

export type RolloutRecord =
  | SessionMetaRecord
  | TaskStartedRecord
  | TaskCompleteRecord
  | TurnAbortedRecord
  | TurnContextRecord
  | UsageRecord
  | TokenCountRecord
  | ReasoningRecord
  | UserTextRecord
  | AssistantTextRecord
  | DeveloperTextRecord
  | AgentMessageRecord
  | ToolCallRecord
  | ToolOutputRecord
  | ItemRecord
  | ToolsRecord
  | CompactedRecord
  | SkipRecord
  | UnknownRecord
  | InvalidRecord;

const KNOWN_ITEMS = new Set([
  'Reasoning',
  'Extension',
  'CommandExecution',
  'AgentMessage',
  'McpToolCall',
  'UserMessage',
  'ImageView',
  'SubAgentActivity',
  'CollabAgentToolCall',
  'FileChange',
  'ContextCompaction',
  'FunctionCallOutput',
  'DynamicToolCall',
  'WebSearch',
]);

const SKIP_EVENTS = new Set(['thread_settings_applied']);

function ordinalOf(raw: Obj): number {
  return num(raw.ordinal) ?? 0;
}

function turnIdOf(payload: Obj): string | null {
  const direct = str(payload.turn_id);
  if (direct) return direct;
  const pass = payload.internal_chat_message_metadata_passthrough;
  if (!isObj(pass)) return null;
  return str(pass.turn_id);
}

function summaryText(summary: unknown): string | null {
  if (!Array.isArray(summary)) return null;
  const text = summary
    .map((part) => (isObj(part) ? str(part.text) : null))
    .filter((part): part is string => part !== null)
    .join('\n');
  return text.trim() === '' ? null : text;
}

function durationMs(payload: Obj, item: Obj): number | null {
  const started = num(payload.started_at_ms);
  const ended = num(payload.completed_at_ms);
  if (started !== null && ended !== null) return Math.max(0, Math.round(ended - started));
  const duration = item.duration;
  if (!isObj(duration)) return null;
  const secs = num(duration.secs);
  const nanos = num(duration.nanos);
  if (secs === null && nanos === null) return null;
  return Math.max(0, Math.round((secs ?? 0) * 1000 + (nanos ?? 0) / 1e6));
}

function sessionMeta(raw: Obj, payload: Obj): SessionMetaRecord {
  const source = payload.source;
  let agentType: string | null = null;
  let label: string | null = null;
  let parent = str(payload.parent_thread_id);
  if (isObj(source) && isObj(source.subagent)) {
    const sub = source.subagent;
    if (isObj(sub.thread_spawn)) {
      const spawn = sub.thread_spawn;
      agentType = str(spawn.agent_path);
      label = str(spawn.agent_nickname) ?? agentType;
      parent = parent ?? str(spawn.parent_thread_id);
    } else if (typeof sub.other === 'string' && sub.other.trim() !== '') {
      agentType = sub.other;
      label = sub.other;
    }
  }
  const instructions = payload.base_instructions;
  const system = isObj(instructions) ? str(instructions.text) : null;
  return {
    kind: 'session-meta',
    id: str(payload.id) ?? str(payload.session_id) ?? '',
    cwd: str(payload.cwd),
    startedAt: toIso(payload.timestamp) ?? toIso(raw.timestamp),
    version: str(payload.cli_version),
    parentThreadId: parent,
    agentType,
    label,
    system,
    historyStart: (() => {
      const n = num(payload.subagent_history_start_ordinal);
      return n !== null && n >= 0 ? n : null;
    })(),
    timestamp: toIso(raw.timestamp),
    ordinal: ordinalOf(raw),
  };
}

function itemRecord(raw: Obj, payload: Obj): ItemRecord {
  const item = isObj(payload.item) ? payload.item : {};
  const itemType = str(item.type) ?? 'unknown';
  const result = isObj(item.result) ? item.result : null;
  const status = str(item.status);
  const exitCode = num(item.exit_code);
  const flagged =
    result?.isError === true || status === 'failed' || (exitCode !== null && exitCode !== 0);
  const aggregated = str(item.aggregated_output) ?? str(item.output);
  return {
    kind: 'item',
    itemType,
    itemId: str(item.id),
    status,
    isError: flagged,
    startedAt: toIso(payload.started_at_ms),
    endedAt: toIso(payload.completed_at_ms),
    durationMs: durationMs(payload, item),
    outputText: aggregated,
    text: textOf(item.content).trim() || null,
    agentThreadId: str(item.agent_thread_id),
    agentPath: str(item.agent_path),
    activityKind: str(item.kind),
    known: KNOWN_ITEMS.has(itemType),
    timestamp: toIso(raw.timestamp),
    ordinal: ordinalOf(raw),
  };
}

function responseItem(raw: Obj, payload: Obj): RolloutRecord {
  const type = str(payload.type) ?? 'unknown';
  const turnId = turnIdOf(payload);
  const timestamp = toIso(raw.timestamp);
  const ordinal = ordinalOf(raw);
  if (type === 'reasoning') {
    return { kind: 'reasoning', turnId, text: summaryText(payload.summary), timestamp, ordinal };
  }
  if (type === 'message') {
    const role = str(payload.role) ?? 'unknown';
    const text = textOf(payload.content);
    if (role === 'user') return { kind: 'user-text', turnId, text, timestamp, ordinal };
    if (role === 'developer') return { kind: 'developer-text', turnId, ordinal };
    if (role === 'assistant') return { kind: 'assistant-text', turnId, text, timestamp, ordinal };
    return { kind: 'unknown', type: `response_item:message:${role}` };
  }
  if (type === 'custom_tool_call' || type === 'function_call') {
    const callId = str(payload.call_id);
    if (!callId) return { kind: 'unknown', type: `response_item:${type}` };
    const input =
      type === 'function_call' ? parseJsonish(payload.arguments) : (payload.input ?? {});
    return {
      kind: 'tool-call',
      callId,
      name: str(payload.name) ?? type,
      input,
      status: str(payload.status),
      turnId,
      timestamp,
      ordinal,
    };
  }
  // Newer logs record a search as its own response item. The id matches the WebSearch
  // item; there is no call_id. TokenUsage.webSearch stays 0 — the usage object has no
  // web-search counter.
  if (type === 'web_search_call') {
    const callId = str(payload.id);
    if (!callId) return { kind: 'unknown', type: 'response_item:web_search_call' };
    return {
      kind: 'tool-call',
      callId,
      name: 'web_search',
      input: isObj(payload.action) ? payload.action : {},
      status: str(payload.status),
      turnId,
      timestamp,
      ordinal,
    };
  }
  if (type === 'custom_tool_call_output' || type === 'function_call_output') {
    const callId = str(payload.call_id);
    if (!callId) return { kind: 'unknown', type: `response_item:${type}` };
    return {
      kind: 'tool-output',
      callId,
      output: payload.output ?? '',
      turnId,
      timestamp,
      ordinal,
    };
  }
  if (type === 'agent_message') {
    return { kind: 'agent-message', turnId, text: textOf(payload.content), timestamp, ordinal };
  }
  if (type === 'compaction') return { kind: 'compacted', timestamp, ordinal };
  if (type === 'additional_tools') return { kind: 'skip', type: 'response_item:additional_tools' };
  return { kind: 'unknown', type: `response_item:${type}` };
}

function eventMsg(raw: Obj, payload: Obj): RolloutRecord {
  const type = str(payload.type) ?? 'unknown';
  const timestamp = toIso(raw.timestamp);
  const ordinal = ordinalOf(raw);
  if (type === 'task_started') {
    const turnId = str(payload.turn_id);
    if (!turnId) return { kind: 'unknown', type: 'event_msg:task_started' };
    const attribution = isObj(payload.turn_attribution) ? payload.turn_attribution : {};
    return {
      kind: 'task-started',
      turnId,
      startedAt: toIso(payload.started_at) ?? timestamp,
      trigger: str(attribution.turn_trigger),
      timestamp,
      ordinal,
    };
  }
  if (type === 'task_complete') {
    const turnId = str(payload.turn_id);
    if (!turnId) return { kind: 'unknown', type: 'event_msg:task_complete' };
    const error = isObj(payload.error) ? payload.error : null;
    return {
      kind: 'task-complete',
      turnId,
      endedAt: toIso(payload.completed_at) ?? timestamp,
      errorMessage: error ? str(error.message) : null,
      timestamp,
      ordinal,
    };
  }
  if (type === 'turn_aborted') {
    return { kind: 'turn-aborted', turnId: str(payload.turn_id), timestamp, ordinal };
  }
  if (type === 'item_completed') return itemRecord(raw, payload);
  if (type === 'token_count') {
    const info = isObj(payload.info) ? payload.info : null;
    const last = info && isObj(info.last_token_usage) ? info.last_token_usage : null;
    const total = info && isObj(info.total_token_usage) ? info.total_token_usage : null;
    return {
      kind: 'token-count',
      usage: last ? mapCodexUsage(last) : null,
      usageKey: last ? jsonOf(total ?? last) : null,
      cumulative: last !== null && total !== null,
      timestamp,
      ordinal,
    };
  }
  if (SKIP_EVENTS.has(type)) return { kind: 'skip', type: `event_msg:${type}` };
  return { kind: 'unknown', type: `event_msg:${type}` };
}

function toolsFromWorld(payload: Obj, ordinal: number): ToolsRecord | SkipRecord {
  const state = isObj(payload.state) ? payload.state : payload;
  const listed = state.top_level_tools ?? state.tools;
  if (!Array.isArray(listed)) return { kind: 'skip', type: 'world_state' };
  return { kind: 'tools', tools: listed, ordinal };
}

/** Never throws. A blank or non-JSON line is `invalid`. */
export function parseRolloutLine(line: string): RolloutRecord {
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
  const payload = isObj(raw.payload) ? raw.payload : {};
  const rec = recordOf(raw, type, payload);
  // Every kept record carries its position, so a copied range can be cut out exactly.
  if ((rec.kind === 'unknown' || rec.kind === 'skip') && num(raw.ordinal) !== null)
    return { ...rec, ordinal: num(raw.ordinal) as number };
  return rec;
}

function recordOf(raw: Obj, type: string, payload: Obj): RolloutRecord {
  if (type === 'session_meta') {
    const meta = sessionMeta(raw, payload);
    return meta.id === '' ? { kind: 'unknown', type: 'session_meta' } : meta;
  }
  if (type === 'event_msg') return eventMsg(raw, payload);
  if (type === 'response_item') return responseItem(raw, payload);
  if (type === 'token_usage_record') {
    const responseId = str(payload.response_id);
    const usage = mapCodexUsage(payload.usage);
    if (!responseId || !usage) return { kind: 'unknown', type: 'token_usage_record' };
    return {
      kind: 'usage',
      responseId,
      turnId: str(payload.turn_id),
      usage,
      timestamp: toIso(raw.timestamp),
      ordinal: ordinalOf(raw),
    };
  }
  if (type === 'turn_context') {
    return {
      kind: 'turn-context',
      turnId: str(payload.turn_id),
      model: str(payload.model),
      effort: str(payload.effort),
      timestamp: toIso(raw.timestamp),
      ordinal: ordinalOf(raw),
    };
  }
  if (type === 'world_state') return toolsFromWorld(payload, ordinalOf(raw));
  if (type === 'compacted') {
    return { kind: 'compacted', timestamp: toIso(raw.timestamp), ordinal: ordinalOf(raw) };
  }
  if (type === 'inter_agent_communication_metadata') {
    return { kind: 'skip', type: 'inter_agent_communication_metadata' };
  }
  return { kind: 'unknown', type };
}
