/**
 * Normalises raw Claude Code transcript lines into the small set of fields the parser reads.
 *
 * The transcript format is internal to Claude Code and changes between versions, so every
 * field is read defensively: a wrong type becomes null/0/empty, never an exception.
 */
import type { TokenUsage, TurnOrigin } from '../../core/model.js';

type Obj = Record<string, unknown>;

export interface Envelope {
  uuid: string | null;
  parentUuid: string | null;
  ts: string | null;
  /** Set on sub-agent and workflow-agent records. */
  agentId: string | null;
  isSidechain: boolean;
  version: string | null;
  cwd: string | null;
}

export interface ToolResultPart {
  toolUseId: string;
  content: unknown;
  isError: boolean;
}

export interface UserRecord extends Envelope {
  kind: 'user';
  /** Raw `message`, kept for request-detail hashing. */
  message: unknown;
  /** String content, or the text blocks joined with newlines. */
  text: string;
  isMeta: boolean;
  isCompactSummary: boolean;
  /** Normalised `origin.kind` / `turnOrigin`, e.g. "human", "task-notification", "peer". */
  origin: string | null;
  /** Peer messages: `origin.body` (the unwrapped text), `origin.name`, `origin.from`. */
  originBody: string | null;
  originName: string | null;
  originFrom: string | null;
  toolResults: ToolResultPart[];
  toolUseResult: unknown;
  /** "[Request interrupted by user…]" marker. */
  interrupt: boolean;
}

export type AssistantBlock =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'other' };

export interface AssistantRecord extends Envelope {
  kind: 'assistant';
  message: unknown;
  /** Raw `message.content` blocks, kept for request-detail hashing. */
  content: unknown[];
  requestId: string | null;
  messageId: string | null;
  /** `api-request.id` this response belongs to (≥ 2.1.300). */
  requestRef: string | null;
  apiBlockIndex: number | null;
  model: string | null;
  effort: string | null;
  stopReason: string | null;
  usage: TokenUsage | null;
  /** Raw `output_tokens`, used to pick the final usage among a request's records. */
  outputTokens: number;
  blocks: AssistantBlock[];
  thinkingDurationMs: number | null;
  /** Claude Code's synthetic "API Error: …" message after retries were exhausted. */
  isApiErrorMessage: boolean;
  apiErrorStatus: number | null;
}

export interface ApiRequestRecord {
  kind: 'api-request';
  id: string;
  ts: string | null;
  agentId: string | null;
  version: string | null;
  querySource: string | null;
  params: unknown;
  model: string | null;
  effort: string | null;
  shapeHash: string | null;
  base: string | null;
  keep: number;
  tail: string[];
}

export interface ApiRequestShapeRecord {
  kind: 'api-request-shape';
  shapeHash: string;
  system: unknown;
  tools: unknown[] | null;
}

export interface ApiRequestBlobRecord {
  kind: 'api-request-blob';
  hash: string;
  message: unknown;
}

export interface SystemRecord extends Envelope {
  kind: 'system';
  subtype: string | null;
  /** `turn_duration`. */
  durationMs: number | null;
  /** `api_error`. */
  error: { message: string; status: number | null; retryAttempt: number | null } | null;
}

export interface AttachmentRecord extends Envelope {
  kind: 'attachment';
  subtype: string | null;
}

export interface QueueOperationRecord {
  kind: 'queue-operation';
  ts: string | null;
  operation: string | null;
  content: string | null;
}

export interface TitleRecord {
  /** `agent-name` is the session's name, e.g. "whitefish-7e". */
  kind: 'custom-title' | 'ai-title' | 'agent-name';
  title: string;
}

export interface CostStateRecord {
  kind: 'cost-state';
  totalCostUSD: number | null;
}

export interface OtherRecord {
  kind: 'other';
  type: string;
  /** True for record types Claude Code writes that glassbox deliberately does not use. */
  known: boolean;
}

export type ClaudeRecord =
  | UserRecord
  | AssistantRecord
  | ApiRequestRecord
  | ApiRequestShapeRecord
  | ApiRequestBlobRecord
  | SystemRecord
  | AttachmentRecord
  | QueueOperationRecord
  | TitleRecord
  | CostStateRecord
  | OtherRecord;

/** Record types seen in Claude Code ≤ 2.1.308 that carry nothing glassbox shows. */
const KNOWN_UNUSED = new Set([
  'mode',
  'permission-mode',
  'file-history-snapshot',
  'file-history-delta',
  'last-prompt',
  'atis-latch',
  'pr-link',
  'agent-setting',
  'bridge-session',
  'relocated',
  'worktree-state',
  'frame-link',
  'fork-context-ref',
  'continued-in',
  'summary',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
]);

/** Epoch milliseconds as ISO-8601, or null when not a representable time. */
export function msToIso(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A timestamp string, or null when missing or unparsable (treated as unknown). */
const time = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function mapUsage(raw: unknown): TokenUsage {
  const u = obj(raw);
  const creation = obj(u.cache_creation);
  const server = obj(u.server_tool_use);
  const n = (v: unknown) => num(v) ?? 0;
  return {
    input: n(u.input_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
    cacheWrite5m: n(creation.ephemeral_5m_input_tokens),
    cacheWrite1h: n(creation.ephemeral_1h_input_tokens),
    output: n(u.output_tokens),
    thinking: n(obj(u.output_tokens_details).thinking_tokens),
    webSearch: n(server.web_search_requests),
    webFetch: n(server.web_fetch_requests),
  };
}

function envelope(r: Obj): Envelope {
  return {
    uuid: str(r.uuid),
    parentUuid: str(r.parentUuid),
    ts: time(r.timestamp),
    agentId: str(r.agentId),
    isSidechain: r.isSidechain === true,
    version: str(r.version),
    cwd: str(r.cwd),
  };
}

/** `turnOrigin` spells kinds with underscores ("task_notification", "auto_continuation"). */
const TURN_ORIGIN_KINDS: Record<string, string> = {
  task_notification: 'task-notification',
  auto_continuation: 'auto-continuation',
};

function normaliseOrigin(r: Obj): string | null {
  const kind = str(obj(r.origin).kind) ?? str(r.turnOrigin);
  return kind === null ? null : (TURN_ORIGIN_KINDS[kind] ?? kind);
}

function parseUser(r: Obj): UserRecord {
  const message = obj(r.message);
  const content = message.content;
  const parts = arr(content);
  const text =
    typeof content === 'string'
      ? content
      : parts
          .filter((p) => isObj(p) && p.type === 'text')
          .map((p) => str((p as Obj).text) ?? '')
          .join('\n');
  const toolResults: ToolResultPart[] = [];
  for (const p of parts) {
    if (isObj(p) && p.type === 'tool_result' && typeof p.tool_use_id === 'string')
      toolResults.push({
        toolUseId: p.tool_use_id,
        content: p.content,
        isError: p.is_error === true,
      });
  }
  return {
    kind: 'user',
    ...envelope(r),
    message: r.message,
    text,
    isMeta: r.isMeta === true,
    isCompactSummary: r.isCompactSummary === true,
    origin: normaliseOrigin(r),
    originBody: str(obj(r.origin).body),
    originName: str(obj(r.origin).name),
    originFrom: str(obj(r.origin).from),
    toolResults,
    toolUseResult: r.toolUseResult,
    interrupt: text.startsWith('[Request interrupted by user'),
  };
}

function parseBlock(b: unknown): AssistantBlock {
  if (!isObj(b)) return { type: 'other' };
  if (b.type === 'thinking') return { type: 'thinking', text: str(b.thinking) ?? '' };
  if (b.type === 'text') return { type: 'text', text: str(b.text) ?? '' };
  if (b.type === 'tool_use' && typeof b.id === 'string')
    return { type: 'tool_use', id: b.id, name: str(b.name) ?? '?', input: b.input };
  return { type: 'other' };
}

function parseAssistant(r: Obj): AssistantRecord {
  const message = obj(r.message);
  const content = arr(message.content);
  return {
    kind: 'assistant',
    ...envelope(r),
    message: r.message,
    content,
    requestId: str(r.requestId),
    messageId: str(message.id),
    requestRef: str(r.requestRef),
    apiBlockIndex: num(r.apiBlockIndex),
    model: str(message.model),
    effort: str(r.effort),
    stopReason: str(message.stop_reason),
    usage: isObj(message.usage) ? mapUsage(message.usage) : null,
    outputTokens: num(obj(message.usage).output_tokens) ?? 0,
    blocks: content.map(parseBlock),
    thinkingDurationMs: num(r.thinkingDurationMs),
    isApiErrorMessage: r.isApiErrorMessage === true,
    apiErrorStatus: num(r.apiErrorStatus),
  };
}

function parseSystem(r: Obj): SystemRecord {
  const subtype = str(r.subtype);
  const err = obj(r.error);
  return {
    kind: 'system',
    ...envelope(r),
    subtype,
    durationMs: num(r.durationMs),
    error:
      subtype === 'api_error'
        ? {
            message: str(err.message) ?? str(err.formatted) ?? 'API error',
            status: num(err.status),
            retryAttempt: num(r.retryAttempt),
          }
        : null,
  };
}

export function parseRecord(line: string): ClaudeRecord | { kind: 'invalid' } {
  let r: unknown;
  try {
    r = JSON.parse(line);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isObj(r)) return { kind: 'invalid' };
  const type = str(r.type) ?? '(none)';
  switch (type) {
    case 'user':
      return parseUser(r);
    case 'assistant':
      return parseAssistant(r);
    case 'api-request': {
      const params = obj(r.params);
      if (typeof r.id !== 'string') return { kind: 'other', type, known: true };
      return {
        kind: 'api-request',
        id: r.id,
        ts: time(r.timestamp),
        agentId: str(r.agentId),
        version: str(r.version),
        querySource: str(r.querySource),
        params: r.params ?? null,
        model: str(params.model),
        effort: str(obj(params.output_config).effort),
        shapeHash: str(r.shapeHash),
        base: str(r.base),
        keep: num(r.keep) ?? 0,
        tail: arr(r.tail).filter((h): h is string => typeof h === 'string'),
      };
    }
    case 'api-request-shape': {
      const shape = obj(r.shape);
      if (typeof r.shapeHash !== 'string') return { kind: 'other', type, known: true };
      return {
        kind: 'api-request-shape',
        shapeHash: r.shapeHash,
        system: shape.system ?? null,
        tools: Array.isArray(shape.tools) ? shape.tools : null,
      };
    }
    case 'api-request-blob':
      if (typeof r.hash !== 'string') return { kind: 'other', type, known: true };
      return { kind: 'api-request-blob', hash: r.hash, message: r.message };
    case 'system':
      return parseSystem(r);
    case 'attachment':
      return { kind: 'attachment', ...envelope(r), subtype: str(obj(r.attachment).type) };
    case 'queue-operation':
      return {
        kind: 'queue-operation',
        ts: time(r.timestamp),
        operation: str(r.operation),
        content: str(r.content),
      };
    case 'custom-title':
      return { kind: 'custom-title', title: str(r.customTitle) ?? '' };
    case 'ai-title':
      return { kind: 'ai-title', title: str(r.aiTitle) ?? '' };
    case 'agent-name':
      return { kind: 'agent-name', title: str(r.agentName) ?? '' };
    case 'cost-state':
      return { kind: 'cost-state', totalCostUSD: num(r.totalCostUSD) };
    default:
      return { kind: 'other', type, known: KNOWN_UNUSED.has(type) };
  }
}

/** User records that echo local command output; they are not inputs to the model. */
const ECHO_PREFIX = /^\s*<(local-command-stdout|local-command-caveat|bash-stdout|bash-stderr)>/;

/**
 * The origin of the turn a user record starts, or null when it starts none (tool results,
 * interrupt markers, compact summaries, meta records, command echoes). Records with explicit
 * origin metadata start a turn even when meta: peer messages are written as meta records.
 */
export function promptOrigin(rec: UserRecord, mainAgent: boolean): TurnOrigin | null {
  if (rec.toolResults.length > 0 || rec.interrupt || rec.isCompactSummary) return null;
  switch (rec.origin) {
    case 'human':
    case 'task-notification':
    case 'peer':
    // Written as meta once a usage limit resets: the work after it is a new turn.
    case 'auto-continuation':
      return rec.origin;
    case 'sdk':
      // stream-json input, e.g. a glassbox run: what a person typed into another client.
      return rec.isMeta ? null : 'human';
    case null:
      break;
    default:
      return rec.isMeta ? null : 'other';
  }
  if (rec.isMeta || ECHO_PREFIX.test(rec.text)) return null;
  // Without origin metadata (older versions, slash commands) a main-agent prompt is human.
  return mainAgent ? 'human' : 'other';
}

// Prompt text is untrusted (pastes, peer messages, sub-agent output) and is cleaned on the
// server's event loop, so everything below scans linearly: no lazy `[\s\S]*?` per opening
// tag, no backreferences. records.redos.test.ts holds the old regexes as the reference.

/** Trimmed content of the first `<name>…</name>`; undefined when there is none. */
function tagContent(text: string, name: string): string | undefined {
  const open = `<${name}>`;
  const start = text.indexOf(open);
  if (start === -1) return undefined;
  // No close after the first opening means none after any later one either.
  const end = text.indexOf(`</${name}>`, start + open.length);
  return end === -1 ? undefined : text.slice(start + open.length, end).trim();
}

const tagText = (text: string, name: string) => tagContent(text, name) || null;

/**
 * `<cross-session-message attrs>body</cross-session-message>`: the first opening, its first
 * `>`, and the first close after it, as the regex `<x([^>]*)>([\s\S]*?)</x>` would match.
 */
function peerEnvelope(text: string): { attrs: string; body: string } | null {
  const open = '<cross-session-message';
  const start = text.indexOf(open);
  if (start === -1) return null;
  const gt = text.indexOf('>', start + open.length);
  if (gt === -1) return null;
  const end = text.indexOf('</cross-session-message>', gt + 1);
  if (end === -1) return null;
  return { attrs: text.slice(start + open.length, gt), body: text.slice(gt + 1, end) };
}

/** `name="value"` in an attribute list, the name at the start or after whitespace. */
function attribute(attrs: string, name: string): string | null {
  const key = `${name}="`;
  for (let at = attrs.indexOf(key); at !== -1; at = attrs.indexOf(key, at + 1)) {
    if (at > 0 && !isSpace(attrs.charCodeAt(at - 1))) continue;
    const end = attrs.indexOf('"', at + key.length);
    // No closing quote here means none for a later key either.
    return end === -1 ? null : attrs.slice(at + key.length, end);
  }
  return null;
}

/**
 * A turn's prompt without transport wrappers, and who sent it: peer messages give their body
 * and sender session name; task notifications their summary and task id.
 */
export function turnInput(
  rec: UserRecord,
  origin: TurnOrigin,
): { prompt: string; sender: string | null } {
  if (origin === 'peer') {
    const m = peerEnvelope(rec.text);
    const attr = (name: string) => (m ? attribute(m.attrs, name) : null);
    return {
      prompt: rec.originBody ?? m?.body.trim() ?? rec.text,
      sender: rec.originName ?? attr('from-name') ?? rec.originFrom ?? attr('from'),
    };
  }
  if (origin === 'task-notification')
    return {
      prompt: tagText(rec.text, 'summary') ?? rec.text,
      sender: tagText(rec.text, 'task-id'),
    };
  return { prompt: rec.text, sender: null };
}

/** Blocks Claude Code wraps around or before a prompt that are not what the person typed. */
const NOISE_TAGS = [
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'command-message',
  'system-reminder',
  'bash-stdout',
  'bash-stderr',
  'fork-boilerplate',
  'artifact-view-context',
];
/** Transport wrappers whose content is the prompt itself. */
const WRAPPER_TAGS = ['cross-session-message', 'pasted_content'];
const LABEL = /^\[[\w-]+\]$/;
/** Longest cleaned prompt kept on a turn; the raw text stays in the request detail. */
const PROMPT_MAX = 64 * 1024;

/** `\s` for one UTF-16 unit, as in a regex. */
function isSpace(c: number): boolean {
  return (
    c === 0x20 ||
    (c >= 0x09 && c <= 0x0d) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** `[\w-]` for one UTF-16 unit. */
function isNameChar(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x5f ||
    c === 0x2d
  );
}

/**
 * `text.indexOf(needle, from)` for calls with non-decreasing `from`: a search resumes where the
 * last one ended, so a scan stays linear however many openings lack their `>` or close.
 */
function forwardSearch(text: string, needle: string): (from: number) => number {
  let at = -2;
  return (from) => {
    if (at === -1 || at >= from) return at;
    at = text.indexOf(needle, from);
    return at;
  };
}

/**
 * The opening tag `<name>` or `<name attrs>` at `i` (one of `names`, followed by `>` or
 * whitespace): the name and the index of its `>`. `slash` allows `</name …>`.
 */
function tagAt(
  text: string,
  i: number,
  names: string[],
  nextGt: (from: number) => number,
  slash = false,
): { name: string; close: boolean; gt: number } | null {
  let j = i + 1;
  const close = slash && text.charCodeAt(j) === 0x2f;
  if (close) j += 1;
  for (const name of names) {
    if (!text.startsWith(name, j)) continue;
    const after = j + name.length;
    const c = text.charCodeAt(after);
    if (c === 0x3e) return { name, close, gt: after };
    if (!isSpace(c)) continue;
    const gt = nextGt(after);
    return gt === -1 ? null : { name, close, gt };
  }
  return null;
}

/** Drops every noise block: an opening tag through the first matching close after it. */
function stripNoise(text: string): string {
  const nextGt = forwardSearch(text, '>');
  const closes = new Map<string, (from: number) => number>();
  let out = '';
  let kept = 0;
  for (let i = text.indexOf('<'); i !== -1; ) {
    const tag = tagAt(text, i, NOISE_TAGS, nextGt);
    if (tag) {
      let next = closes.get(tag.name);
      if (!next) {
        next = forwardSearch(text, `</${tag.name}>`);
        closes.set(tag.name, next);
      }
      const end = next(tag.gt + 1);
      if (end !== -1) {
        out += text.slice(kept, i);
        kept = end + tag.name.length + 3;
        i = text.indexOf('<', kept);
        continue;
      }
    }
    i = text.indexOf('<', i + 1);
  }
  return out + text.slice(kept);
}

/** Drops the wrapper tags themselves (opening and closing), keeping what they wrap. */
function stripWrappers(text: string): string {
  const nextGt = forwardSearch(text, '>');
  let out = '';
  let kept = 0;
  for (let i = text.indexOf('<'); i !== -1; ) {
    const tag = tagAt(text, i, WRAPPER_TAGS, nextGt, true);
    if (tag) {
      out += text.slice(kept, i);
      kept = tag.gt + 1;
      i = text.indexOf('<', kept);
      continue;
    }
    i = text.indexOf('<', i + 1);
  }
  return out + text.slice(kept);
}

/**
 * The element name when `text` is one XML-style element and nothing else, e.g.
 * `<artifact-view …/>` or `<x a="1">…</x>`; null otherwise.
 */
function soleElement(text: string): string | null {
  if (text.charCodeAt(0) !== 0x3c) return null;
  const first = text.charCodeAt(1);
  if (!((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a))) return null;
  let j = 2;
  while (j < text.length && isNameChar(text.charCodeAt(j))) j++;
  const name = text.slice(1, j);
  const c = text.charCodeAt(j);
  const last = text.length - 1;
  if (c === 0x2f) return j + 1 === last && text.charCodeAt(last) === 0x3e ? name : null;
  if (c !== 0x3e && !isSpace(c)) return null;
  // The opening tag ends at its first `>`: attributes cannot contain one.
  const gt = text.indexOf('>', j);
  if (gt === -1) return null;
  if (gt === last && text.charCodeAt(gt - 1) === 0x2f && gt - 1 > j) return name;
  const close = `</${name}>`;
  return text.length - close.length > gt && text.endsWith(close) ? name : null;
}

/** At most `max` UTF-16 units, never ending on half of a surrogate pair. */
function capped(text: string, max: number): string {
  if (text.length <= max) return text;
  const high = text.charCodeAt(max - 1);
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max);
}

/**
 * A prompt as the person meant it: slash commands become "/name args", shell escapes "!cmd",
 * task notifications their summary; command output, reminders and context blocks are dropped.
 * A prompt that is only an XML-style element becomes "[element]". The raw text stays available
 * in the request detail.
 */
export function cleanTurnPrompt(text: string): string {
  return capped(cleanFull(text), PROMPT_MAX);
}

function cleanFull(text: string): string {
  const tag = (name: string) => tagContent(text, name);
  const command = tag('command-name');
  if (command) return `${command} ${tag('command-args') ?? ''}`.trim();
  const bash = tag('bash-input');
  if (bash !== undefined) return `!${bash}`;
  const summary = text.includes('<task-notification>') ? tag('summary') : undefined;
  if (summary) return summary;
  const out = stripWrappers(stripNoise(text)).trim();
  const single = soleElement(out);
  if (single) return `[${single}]`;
  if (out) return out;
  const first = /^\s*<([A-Za-z][\w-]*)/.exec(text)?.[1];
  return first ? `[${first}]` : '';
}

/**
 * A slash command the person ran (`<command-name>`). Local ones (/effort, /clear, /login) are
 * handled by Claude Code itself and never reach the model; others (skills, custom commands) do.
 */
export function isSlashCommand(text: string): boolean {
  return tagContent(text, 'command-name') !== undefined;
}

/** A prompt as a one-line session title; null when nothing a person typed is left. */
export function cleanPrompt(text: string): string | null {
  const cleaned = cleanTurnPrompt(text);
  if (LABEL.test(cleaned)) return null;
  return cleaned.replace(/\s+/g, ' ').trim().slice(0, 80) || null;
}

/**
 * Session title by precedence; empty strings count as missing. `command` is a local slash
 * command (/effort): a title only when the session has no other input.
 */
export function pickTitle(t: {
  customTitle: string | null;
  agentName: string | null;
  aiTitle: string | null;
  firstHuman: string | null;
  firstAny: string | null;
  command?: string | null;
}): string | null {
  for (const v of [t.customTitle, t.agentName, t.aiTitle, t.firstHuman, t.firstAny, t.command])
    if (v?.trim()) return v.trim();
  return null;
}

/** ClaudeBar's background probe sessions: its session name and its working directory. */
export const PROBE_NAME = 'ClaudeBar Probe';
export const isProbeCwd = (cwd: string | null | undefined) =>
  typeof cwd === 'string' && /[/\\]ClaudeBar[/\\]Probe[/\\]?$/.test(cwd);
