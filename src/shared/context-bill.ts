/**
 * The context bill: what one request's context was made of, part by part.
 *
 * A request's details (what it sent: Claude Code ≥ 2.1.300 records the system prompt, the tool
 * definitions and the messages of each request) are split into parts: each tool definition, the
 * system prompt, and per message its own text (a prompt, a reply) and each tool call and tool
 * result in it. A part is weighed by its characters (`textTokens`); the request's reported
 * input, cache reads and cache writes are then spread over the parts by weight, so the whole is
 * the request's own count and each part's share an estimate. A prompt is sent tools first, then
 * the system prompt, then the messages, and is cached from its start: a part's tokens are cache
 * reads as far as the request's cache reads reach, cache writes for the stretch after them, and
 * uncached input after that.
 *
 * Pure. Weighing walks each message's characters once per message object, remembered in a
 * WeakMap: the server, weighing an agent's requests that share their message objects, weighs a
 * message once however many requests carry it.
 */
import { activityTarget } from '../core/activity.js';
import type { ModelRequest, RequestDetail, ToolCall } from '../core/model.js';
import { resolvePath, touchesOf } from './files.js';
import {
  type Block,
  blockText,
  isGap,
  readMessage,
  readSystem,
  readTools,
} from './request-read.js';
import { pathField } from './tool-category.js';

/** Characters of English text or code to a token. A CJK character is about a token of its own. */
export const CHARS_PER_TOKEN = 4;

/** An image or a document in the context: about this many tokens, whatever its bytes. */
export const MEDIA_TOKENS = 1_600;

/** What a part of the context is. */
export type PartKind =
  /** The system prompt. */
  | 'system'
  /** One tool definition. */
  | 'tool'
  /** A user message's own text (a prompt, a reminder), images and the like. */
  | 'user'
  /** An assistant message's own text and thinking. */
  | 'reply'
  /** One tool call: its name and input, as the assistant sent it. */
  | 'call'
  /** One tool result. */
  | 'result'
  /** A message of another role (system, developer…). */
  | 'other'
  /** What the agent could not reconstruct: messages, or the system prompt and tools. */
  | 'gap';

export interface TokenSplit {
  cacheRead: number;
  cacheWrite: number;
  input: number;
}

/** One part of a request's context. */
export interface ContextPart {
  /**
   * What the part is across an agent's requests: `result:<call id>`, `tool:<name>`, `system`, a
   * message by what it holds. Two parts alike in one request get `#1`, `#2`… after the second.
   */
  key: string;
  kind: PartKind;
  /** The role of the message it is in; null for the system prompt and tool definitions. */
  role: string | null;
  /** A tool definition's name; the tool of a call, or of the call a result answers. */
  tool: string | null;
  /** The call a 'call' or 'result' part is, or answers. */
  callId: string | null;
  /** What that call worked on, short (a file name, a command's summary); null if unknown. */
  target: string | null;
  /** The file that call names, in full. */
  path: string | null;
  /** A message part's opening words. */
  text: string | null;
  /** True for the parts of the request's last message: what this request added. */
  last: boolean;
  /** A gap's: what is missing. */
  missing?: Missing;
  /** Tokens as its characters suggest. */
  weight: number;
  /** Estimated tokens: the request's total spread by weight. */
  tokens: number;
  /** `tokens` by kind, by where the part sits; null when the request reported no total. */
  split: TokenSplit | null;
}

/** A gap's: what could not be reconstructed. */
export interface Missing {
  messages: number;
  system: boolean;
  tools: boolean;
  /** Tool results recorded by their call alone, without what they returned. */
  results: number;
}

/**
 * Why there is no bill: the request body was not recorded (an agent that keeps none, an older
 * Claude Code); only its system prompt and tools were (Codex, oh-my-pi); its tool results were
 * not (Grok, which counts tokens per prompt besides); nothing of it could be reconstructed; it
 * holds nothing; or, for an agent's requests together, none of them reported its tokens.
 */
export type BillUnavailable =
  | 'not-recorded'
  | 'no-messages'
  | 'no-results'
  | 'not-reconstructed'
  | 'empty'
  | 'no-usage';

export type RequestBill =
  | {
      status: 'ok';
      /** In the order sent: tool definitions, the system prompt, the messages. */
      parts: ContextPart[];
      /** The request's input, cache reads and cache writes; the weights' sum when unreported. */
      total: number;
      /** False while the request has not reported its tokens (in flight): weights alone. */
      measured: boolean;
      /** The request's reported split of `total`, when measured. */
      usage: TokenSplit | null;
    }
  | { status: 'unavailable'; reason: BillUnavailable };

export function textTokens(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      c >= 0x2e80 &&
      (c <= 0x9fff ||
        (c >= 0xac00 && c <= 0xd7af) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xff00 && c <= 0xffef))
    )
      cjk++;
  }
  return (text.length - cjk) / CHARS_PER_TOKEN + cjk;
}

/** A value as the JSON it is sent as. */
function jsonTokens(v: unknown): number {
  if (v === undefined) return 0;
  try {
    return textTokens(JSON.stringify(v) ?? '');
  } catch {
    return 0;
  }
}

/**
 * Weights of tool definitions and system prompts by object: every request of a session sends the
 * same ones, and the server's details share them, so each is weighed once.
 */
const shapeWeights = new WeakMap<object, number>();
function shapeTokens(v: unknown, weigh: (v: unknown) => number): number {
  if (v === null || typeof v !== 'object') return weigh(v);
  const hit = shapeWeights.get(v);
  if (hit !== undefined) return hit;
  const weight = weigh(v);
  shapeWeights.set(v, weight);
  return weight;
}

/** A system prompt: its text blocks, or the JSON of one that is not text. */
function systemTokens(v: unknown): number {
  const blocks = readSystem(v);
  return blocks ? blocks.reduce((s, b) => s + textTokens(b), 0) : jsonTokens(v);
}

function blockTokens(b: Block): number {
  switch (b.kind) {
    case 'text':
      return textTokens(b.text);
    case 'thinking':
      // Kept as a signature: base64, three bytes to four characters, about a byte a character.
      return b.text !== null ? textTokens(b.text) : ((b.sealed ?? 0) * 3) / 4 / CHARS_PER_TOKEN;
    case 'tool-use':
      return textTokens(b.name) + jsonTokens(b.input);
    case 'tool-result':
      return (b.content ?? []).reduce((s, c) => s + blockTokens(c), 0);
    case 'media':
      return MEDIA_TOKENS;
    case 'tool-ref':
      return b.definition !== undefined ? jsonTokens(b.definition) : textTokens(b.name);
    case 'raw':
      return jsonTokens(b.value);
  }
}

/** Opening words: the first line with text, clipped. */
const OPENING_MAX = 80;
/** A line that is a tag alone ("<system-reminder>"): no words to open with. */
const LONE_TAG = /^<\/?[\w:-]+(\s[^<>]*)?>$/;
function opening(text: string): string | null {
  const line = text
    .slice(0, 2_000)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !LONE_TAG.test(l));
  if (!line) return null;
  return line.length > OPENING_MAX ? `${line.slice(0, OPENING_MAX - 1)}…` : line;
}

/** A part as weighed from its message, before a request places it: shared, never changed. */
export interface Weighed {
  kind: PartKind;
  role: string | null;
  tool: string | null;
  callId: string | null;
  /** A call's input, for naming what it works on; a tool definition, the system prompt. */
  input: unknown;
  text: string | null;
  weight: number;
  /** A gap's: messages not reconstructed. */
  gap: number;
  /** The blocks of a message's own text or of a result, for its text (`partTexts`). */
  blocks?: Block[];
  /** A result recorded by its call alone, without what it returned. */
  unrecorded?: true;
}

const weighed = new WeakMap<object, Weighed[]>();

function messageParts(raw: unknown): Weighed[] {
  const keep = raw !== null && typeof raw === 'object';
  const hit = keep ? weighed.get(raw) : undefined;
  if (hit) return hit;
  const parts = weighMessage(raw);
  if (keep) weighed.set(raw, parts);
  return parts;
}

function part(over: Partial<Weighed> & Pick<Weighed, 'kind'>): Weighed {
  return {
    role: null,
    tool: null,
    callId: null,
    input: undefined,
    text: null,
    weight: 0,
    gap: 0,
    ...over,
  };
}

function weighMessage(raw: unknown): Weighed[] {
  const entry = readMessage(raw);
  if (isGap(entry)) return [part({ kind: 'gap', gap: entry.gap })];
  const role = entry.role;
  const kind: PartKind = role === 'user' ? 'user' : role === 'assistant' ? 'reply' : 'other';
  const out: Weighed[] = [];
  // The message's own text, placed where its first block is.
  let own: Weighed | null = null;
  for (const b of entry.blocks) {
    if (b.kind === 'tool-use') {
      out.push(
        part({
          kind: 'call',
          role,
          tool: b.name,
          callId: b.id,
          input: b.input,
          weight: blockTokens(b),
        }),
      );
    } else if (b.kind === 'tool-result') {
      out.push(
        part({
          kind: 'result',
          role,
          callId: b.toolUseId,
          weight: blockTokens(b),
          blocks: b.content ?? [],
          ...(b.content === null ? { unrecorded: true as const } : {}),
        }),
      );
    } else {
      if (!own) {
        own = part({ kind, role, blocks: [] });
        out.push(own);
      }
      own.weight += blockTokens(b);
      own.blocks?.push(b);
      if (own.text === null && b.kind === 'text') own.text = opening(b.text);
    }
  }
  return out.filter((p) => p.weight > 0 || p.unrecorded);
}

/** A part placed in one request: its key there, and whether its message is the last. */
export interface Placed {
  w: Weighed;
  key: string;
  last: boolean;
  /** The gap's: what is missing. */
  missing?: Missing;
  /**
   * The gap's: it takes what the known parts leave of the total, for there is nothing to weigh
   * it by (the system prompt or tools are missing, or every message is).
   */
  remainder?: boolean;
}

/** What one request's details hold, weighed, in the order sent; null when there are no messages. */
export function placeParts(detail: RequestDetail): Placed[] | null {
  if (!Array.isArray(detail.messages)) return null;
  const out: Placed[] = [];
  const seen = new Map<string, number>();
  const place = (w: Weighed, base: string, last = false) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ w, key: n === 0 ? base : `${base}#${n}`, last });
  };
  // What could not be reconstructed is one part, where the first of it was. Made per request,
  // so it can be filled in as more is found missing.
  const missing: Missing = { messages: 0, system: false, tools: false, results: 0 };
  const gap: Placed = { w: part({ kind: 'gap' }), key: 'gap', last: false, missing };
  const addGap = () => {
    if (!out.includes(gap)) out.push(gap);
  };

  const tools = detail.tools === null ? null : readTools(detail.tools);
  if (detail.tools === null) {
    missing.tools = true;
    addGap();
  } else if (tools) {
    detail.tools.forEach((raw, i) => {
      const name = tools[i]?.name ?? '?';
      const weight = shapeTokens(raw, jsonTokens);
      if (weight > 0) place(part({ kind: 'tool', tool: name, weight, input: raw }), `tool:${name}`);
    });
  } else {
    const weight = shapeTokens(detail.tools, jsonTokens);
    if (weight > 0) place(part({ kind: 'tool', weight, input: detail.tools }), 'tool:?');
  }

  if (detail.system === null) {
    missing.system = true;
    addGap();
  } else {
    const weight = shapeTokens(detail.system, systemTokens);
    if (weight > 0) place(part({ kind: 'system', weight, input: detail.system }), 'system');
  }

  const messages = detail.messages;
  // The known messages' weights: a missing one is weighed as their median.
  const sizes: number[] = [];
  messages.forEach((raw, i) => {
    const last = i === messages.length - 1;
    let size = 0;
    for (const w of messageParts(raw)) {
      size += w.weight;
      if (w.unrecorded) missing.results += 1;
      if (w.kind === 'gap') {
        missing.messages += w.gap;
        addGap();
      } else if (w.kind === 'call' || w.kind === 'result') {
        const id = w.callId ?? `?${w.tool ?? ''}:${Math.round(w.weight * 4)}`;
        place(w, `${w.kind}:${id}`, last);
      } else {
        place(w, `${w.kind}:${w.role}:${Math.round(w.weight * 4)}:${w.text ?? ''}`, last);
      }
    }
    if (size > 0) sizes.push(size);
  });
  sizes.sort((a, b) => a - b);
  const median = sizes.length > 0 ? (sizes[Math.floor(sizes.length / 2)] as number) : 0;
  gap.w.gap = missing.messages;
  gap.w.weight = missing.messages * median;
  gap.remainder = missing.system || missing.tools || sizes.length === 0;
  return out;
}

/** A value's JSON, or nothing for one that cannot be written. */
function json(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/** A part's text, as a filter reads it. */
function textOf(w: Weighed): string {
  switch (w.kind) {
    case 'system':
      return (readSystem(w.input) ?? [json(w.input)]).join('\n');
    case 'tool':
      return json(w.input);
    case 'call':
      return `${w.tool ?? ''} ${json(w.input)}`;
    case 'gap':
      return '';
    default:
      return (w.blocks ?? []).map(blockText).join('\n');
  }
}

/** The text of each part of a request, by its key: what a filter over the parts reads. */
export function partTexts(detail: RequestDetail): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of placeParts(detail) ?? []) out.set(p.key, textOf(p.w));
  return out;
}

/** The overlap of [start, start + size) with the cache reads, the cache writes and the rest. */
function splitAt(start: number, size: number, usage: TokenSplit): TokenSplit {
  const end = start + size;
  const overlap = (a: number, b: number) => Math.max(0, Math.min(end, b) - Math.max(start, a));
  const read = usage.cacheRead;
  const write = read + usage.cacheWrite;
  return {
    cacheRead: overlap(0, read),
    cacheWrite: overlap(read, write),
    input: overlap(write, Number.POSITIVE_INFINITY),
  };
}

/**
 * The parts' estimated tokens: the total spread by weight, a gap weighed with the rest. A gap
 * that takes the remainder keeps its own weight's share (scaled down only if the parts outweigh
 * the total) and takes what the parts leave besides.
 */
export function spread(
  weights: number[],
  gapAt: number,
  total: number,
  remainder = false,
): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum === 0) return weights.map(() => 0);
  if (gapAt < 0 || !remainder) return weights.map((w) => (w * total) / sum);
  const scale = Math.min(1, total / sum);
  const tokens = weights.map((w) => w * scale);
  tokens[gapAt] = (tokens[gapAt] as number) + Math.max(0, total - sum * scale);
  return tokens;
}

/** A request weighed, or why it cannot be. */
type Assessed =
  | { reason: BillUnavailable }
  | { reason: null; placed: Placed[]; weights: number[]; gapAt: number; remainder: boolean };

function assess(request: Pick<ModelRequest, 'hasDetail'>, detail: RequestDetail | null): Assessed {
  if (!request.hasDetail || !detail || detail.completeness === 'unavailable')
    return { reason: 'not-recorded' };
  const placed = placeParts(detail);
  if (!placed) return { reason: 'no-messages' };
  if (placed.some((p) => p.w.unrecorded)) return { reason: 'no-results' };
  const gapAt = placed.findIndex((p) => p.w.kind === 'gap');
  const weights = placed.map((p) => p.w.weight);
  const known = placed.reduce((s, p) => (p.w.kind === 'gap' ? s : s + p.w.weight), 0);
  if (known === 0) return { reason: gapAt >= 0 ? 'not-reconstructed' : 'empty' };
  return { reason: null, placed, weights, gapAt, remainder: placed[gapAt]?.remainder ?? false };
}

/** The context bill of one request, from its details. */
export function requestBill(
  request: Pick<ModelRequest, 'hasDetail' | 'usage'>,
  detail: RequestDetail | null,
): RequestBill {
  const a = assess(request, detail);
  if (a.reason !== null) return { status: 'unavailable', reason: a.reason };
  const { placed, weights, gapAt, remainder } = a;

  const u = request.usage;
  const reported = u ? u.input + u.cacheRead + u.cacheWrite : 0;
  const usage =
    reported > 0 && u ? { cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, input: u.input } : null;
  const total = usage ? reported : weights.reduce((s, w) => s + w, 0);
  const tokens = spread(weights, gapAt, total, remainder);

  // The calls of this request, for naming the results that answer them.
  const calls = new Map<string, Weighed>();
  for (const p of placed) if (p.w.kind === 'call' && p.w.callId) calls.set(p.w.callId, p.w);
  let at = 0;
  const parts = placed.map((p, i): ContextPart => {
    const w = p.w;
    const n = tokens[i] as number;
    const call =
      w.kind === 'call' ? w : w.kind === 'result' && w.callId ? calls.get(w.callId) : undefined;
    const split = usage ? splitAt(at, n, usage) : null;
    at += n;
    return {
      key: p.key,
      kind: w.kind,
      role: w.role,
      tool: call?.tool ?? w.tool,
      callId: w.callId,
      target: call?.tool ? activityTarget(call.tool, call.input) : null,
      path: call ? pathField(call.input) : null,
      text: w.text,
      last: p.last,
      ...(p.missing ? { missing: { ...p.missing } } : {}),
      weight: w.weight,
      tokens: n,
      split,
    };
  });
  return { status: 'ok', parts, total, measured: usage !== null, usage };
}

// ── The bill of an agent's requests ───────────────────────────────────────────────────────

/** A call as the files model reads one, from what a request sent: its tool and input. */
const AS_CALL: ToolCall = {
  id: '',
  agentId: '',
  requestId: '',
  name: '',
  input: null,
  status: 'complete',
  startedAt: null,
  endedAt: null,
  durationMs: null,
  resultPreview: null,
  hasFullResult: false,
  spawned: null,
};

/** Items a session's bill keeps: its costliest. */
export const TOP_ITEMS = 12;
/** Reads of one file worth saying so: "3 files were read 5+ times". */
export const REREAD = 5;
/** One item holding this share of all the context is worth naming. */
const CARRIED_SHARE = 0.15;
/** The system prompt and tools at this share of all the context are worth saying. */
const FIXED_SHARE = 0.4;

/** What an agent's requests carried: a file (all its reads), one call or result, a message. */
export type CarriedKind = 'file' | 'result' | 'call' | 'user' | 'reply' | 'other';

export interface CarriedItem {
  /** `file:<path>`, else the key of the part (`result:<call id>`, a message's). */
  key: string;
  kind: CarriedKind;
  /** The tool of the call, or of a file's reads. */
  tool: string | null;
  /** What the call worked on, short. */
  target: string | null;
  /** A file's path, the session's directory resolved. */
  path: string | null;
  /** A message's opening words. */
  text: string | null;
  role: string | null;
  /** Estimated tokens, across every request that carried it. */
  tokens: number;
  split: TokenSplit;
  /** How many requests carried it. */
  requests: number;
  /** A file's: how many times it was read. */
  reads: number;
  /** The call to open: a result's or a call's own, a file's latest read; null for a message. */
  callId: string | null;
  /** The first request that carried it. */
  firstRequestId: string;
}

/** A part a compaction dropped, as the request before it held it. */
export interface DroppedPart {
  key: string;
  kind: PartKind;
  tool: string | null;
  target: string | null;
  path: string | null;
  text: string | null;
  role: string | null;
  callId: string | null;
  tokens: number;
}

export interface CompactionDrop {
  /** The first request after the compaction, and the last one before it. */
  requestId: string;
  beforeId: string;
  at: string | null;
  /** Parts the request before held that the one after does not, and their estimated tokens. */
  dropped: number;
  tokens: number;
  /** The three largest of them. */
  largest: DroppedPart[];
}

export interface FixedCost {
  /** The system prompt and tool definitions, across the requests read. */
  tokens: number;
  split: TokenSplit;
  requests: number;
  /** On average per request, all of it, and the system prompt's and the tools' parts of it. */
  perRequest: number;
  system: number;
  tools: number;
  /** Tool definitions the latest request sent. */
  toolCount: number;
}

/**
 * One line of advice from the numbers: files read again and again, one item holding much of
 * the context, or the fixed part sent with every request. The first that applies.
 */
export type ContextAdvice =
  | { kind: 'rereads'; files: number; reads: number }
  | { kind: 'carried'; share: number; item: CarriedItem }
  | { kind: 'fixed'; share: number; perRequest: number };

/** The bill of an agent's requests: what recurred in their contexts, and what it cost. */
export interface SessionContextBill {
  agentId: string;
  /** The finished requests fed, and those whose context could be read. */
  requests: number;
  read: number;
  /** Why none could be read, when none could. */
  unavailable: BillUnavailable | null;
  /** All the context the requests read sent: their reported totals. */
  tokens: number;
  split: TokenSplit;
  fixed: FixedCost | null;
  /** What was carried most, the costliest first. */
  items: CarriedItem[];
  compactions: CompactionDrop[];
  advice: ContextAdvice | null;
}

const zero = (): TokenSplit => ({ cacheRead: 0, cacheWrite: 0, input: 0 });
const addSplit = (to: TokenSplit, s: TokenSplit) => {
  to.cacheRead += s.cacheRead;
  to.cacheWrite += s.cacheWrite;
  to.input += s.input;
};

interface Carried {
  key: string;
  kind: CarriedKind;
  /** The part it was first seen as, for its role, text and call. */
  w: Weighed;
  tokens: number;
  split: TokenSplit;
  requests: number;
  /** The last request that carried it, so a request counts once. */
  last: string;
  first: string;
  path: string | null;
  /** A file's reads: their call ids, the latest last; the lines of each; how many read again. */
  reads: string[];
  ranges: [number, number][];
  rereads: number;
}

interface Held {
  key: string;
  w: Weighed;
  tokens: number;
}

/** A read's file, and its lines: [first, last], the last Infinity when it read to the end. */
interface FileRead {
  path: string;
  lines: [number, number];
}

/** The lines a read names as the files model writes them: "36-65", "36" (to the end), or all. */
function lineRange(lines: string | null): [number, number] {
  const m = lines ? /^(\d+)(?:-(\d+))?$/.exec(lines) : null;
  if (!m) return [1, Number.POSITIVE_INFINITY];
  const from = Number(m[1]);
  return [from, m[2] ? Number(m[2]) : Number.POSITIVE_INFINITY];
}

/**
 * What an agent's requests carried in their contexts, fed one finished request at a time in
 * order (so the server can keep one per agent and feed it only what is new): each part spread
 * as `requestBill` spreads it, gathered by key, a file's reads under its path; the system
 * prompt and tools as the fixed cost; at each compaction, what the request before held that the
 * one after does not.
 */
export class ContextLedger {
  /** The requests fed, in order. */
  readonly fed: string[] = [];
  private read = 0;
  private tokens = 0;
  private readonly split = zero();
  private readonly reasons = new Map<BillUnavailable, number>();
  private readonly items = new Map<string, Carried>();
  /** Every call seen, by id: a result is named by its call, a read by its file. */
  private readonly calls = new Map<string, Weighed>();
  private readonly files = new Map<string, FileRead | null>();
  /** The system prompt and tools, and the requests that sent them. */
  private readonly fixed = {
    tokens: 0,
    split: zero(),
    system: 0,
    tools: 0,
    toolCount: 0,
    requests: 0,
  };
  private before: { id: string; held: Held[] } | null = null;
  private readonly drops: (Omit<CompactionDrop, 'largest'> & { largest: Held[] })[] = [];

  constructor(
    readonly agentId: string,
    /** The session's directory, to resolve the paths of reads written relative to it. */
    private readonly cwd: string | null = null,
  ) {}

  add(request: ModelRequest, detail: RequestDetail | null): void {
    this.fed.push(request.id);
    const a = assess(request, detail);
    const u = request.usage;
    const total = u ? u.input + u.cacheRead + u.cacheWrite : 0;
    // Not finished, or it reported nothing: there is no total to spread.
    const reason = a.reason ?? (!u || total === 0 ? 'no-usage' : null);
    if (reason !== null || a.reason !== null || !u) {
      if (reason) this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1);
      return;
    }
    const { placed, weights, gapAt, remainder } = a;
    const usage = { cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, input: u.input };
    const tokens = spread(weights, gapAt, total, remainder);
    this.read += 1;
    this.tokens += total;
    addSplit(this.split, usage);

    const held: Held[] = [];
    let at = 0;
    let toolCount = 0;
    let fixed = false;
    placed.forEach((p, i) => {
      const w = p.w;
      const n = tokens[i] as number;
      const split = splitAt(at, n, usage);
      at += n;
      if (w.kind === 'system' || w.kind === 'tool') {
        fixed = true;
        this.fixed.tokens += n;
        addSplit(this.fixed.split, split);
        if (w.kind === 'system') this.fixed.system += n;
        else {
          this.fixed.tools += n;
          toolCount += 1;
        }
        return;
      }
      if (w.kind === 'gap') return;
      if (w.kind === 'call' && w.callId && !this.calls.has(w.callId)) this.calls.set(w.callId, w);
      held.push({ key: p.key, w, tokens: n });
      const read = this.readOf(w);
      const path = read?.path ?? null;
      const key = path ? `file:${path}` : p.key;
      let item = this.items.get(key);
      if (!item) {
        item = {
          key,
          kind: path ? 'file' : (w.kind as CarriedKind),
          w,
          tokens: 0,
          split: zero(),
          requests: 0,
          last: '',
          first: request.id,
          path,
          reads: [],
          ranges: [],
          rereads: 0,
        };
        this.items.set(key, item);
      }
      item.tokens += n;
      addSplit(item.split, split);
      if (item.last !== request.id) {
        item.requests += 1;
        item.last = request.id;
      }
      // A read again of lines already read: paging through a file in parts is one read of it.
      if (read && w.callId && !item.reads.includes(w.callId)) {
        const [from, to] = read.lines;
        if (item.ranges.some(([a, b]) => from <= b && a <= to)) item.rereads += 1;
        item.ranges.push(read.lines);
        item.reads.push(w.callId);
      }
    });
    if (fixed) this.fixed.requests += 1;
    if (toolCount > 0) this.fixed.toolCount = toolCount;

    if (request.compactedBefore && this.before) {
      const now = new Set(placed.map((p) => p.key));
      const gone = this.before.held.filter((h) => !now.has(h.key));
      this.drops.push({
        requestId: request.id,
        beforeId: this.before.id,
        at: request.startedAt,
        dropped: gone.length,
        tokens: gone.reduce((s, h) => s + h.tokens, 0),
        largest: [...gone].sort((a, b) => b.tokens - a.tokens).slice(0, 3),
      });
    }
    this.before = { id: request.id, held };
  }

  /** The file a call or result reads, resolved, and its lines; null when it is not a read. */
  private readOf(w: Weighed): FileRead | null {
    if (w.kind !== 'call' && w.kind !== 'result') return null;
    const id = w.callId;
    if (!id) return null;
    const known = this.files.get(id);
    if (known !== undefined) return known;
    const call = w.kind === 'call' ? w : this.calls.get(id);
    if (!call?.tool) return null;
    const touch = touchesOf({ ...AS_CALL, name: call.tool, input: call.input }).find(
      (t) => t.verb === 'read',
    );
    const read = touch
      ? { path: resolvePath(touch.path, this.cwd), lines: lineRange(touch.lines) }
      : null;
    this.files.set(id, read);
    return read;
  }

  /** A call's tool and what it worked on. */
  private callName(callId: string | null): { tool: string | null; target: string | null } {
    const call = callId ? this.calls.get(callId) : undefined;
    return call?.tool
      ? { tool: call.tool, target: activityTarget(call.tool, call.input) }
      : { tool: null, target: null };
  }

  private dropped(h: Held): DroppedPart {
    const w = h.w;
    const call = w.kind === 'call' || w.kind === 'result' ? w.callId : null;
    return {
      key: h.key,
      kind: w.kind,
      ...this.callName(call),
      path: this.readOf(w)?.path ?? null,
      text: w.text,
      role: w.role,
      callId: call,
      tokens: h.tokens,
    };
  }

  bill(top = TOP_ITEMS): SessionContextBill {
    const all = [...this.items.values()].sort((a, b) => b.tokens - a.tokens);
    const items = all.slice(0, top).map((c): CarriedItem => {
      const callId = c.kind === 'file' ? (c.reads.at(-1) ?? null) : c.w.callId;
      return {
        key: c.key,
        kind: c.kind,
        ...this.callName(callId),
        path: c.path,
        text: c.w.text,
        role: c.w.role,
        tokens: c.tokens,
        split: { ...c.split },
        requests: c.requests,
        reads: c.reads.length,
        callId,
        firstRequestId: c.first,
      };
    });
    const read = this.read;
    const sent = this.fixed.requests;
    const fixed: FixedCost | null =
      sent > 0 && this.fixed.tokens > 0
        ? {
            tokens: this.fixed.tokens,
            split: { ...this.fixed.split },
            requests: sent,
            perRequest: this.fixed.tokens / sent,
            system: this.fixed.system / sent,
            tools: this.fixed.tools / sent,
            toolCount: this.fixed.toolCount,
          }
        : null;
    // Files whose same lines were read REREAD times or more.
    const rereads = all.filter((c) => c.kind === 'file' && c.rereads + 1 >= REREAD).length;
    const first = items[0];
    const advice: ContextAdvice | null =
      read === 0
        ? null
        : rereads > 0
          ? { kind: 'rereads', files: rereads, reads: REREAD }
          : first && first.tokens / this.tokens >= CARRIED_SHARE
            ? { kind: 'carried', share: first.tokens / this.tokens, item: first }
            : fixed && fixed.tokens / this.tokens >= FIXED_SHARE
              ? { kind: 'fixed', share: fixed.tokens / this.tokens, perRequest: fixed.perRequest }
              : null;
    const reasons = [...this.reasons.entries()].sort((a, b) => b[1] - a[1]);
    return {
      agentId: this.agentId,
      requests: this.fed.length,
      read,
      unavailable: read === 0 ? (reasons[0]?.[0] ?? null) : null,
      tokens: this.tokens,
      split: { ...this.split },
      fixed,
      items,
      compactions: this.drops.map((d) => ({
        ...d,
        largest: d.largest.map((h) => this.dropped(h)),
      })),
      advice,
    };
  }
}

/** The bill of an agent's finished requests, in order: a ledger fed them all. */
export function sessionBill(
  agentId: string,
  entries: Iterable<{ request: ModelRequest; detail: RequestDetail | null }>,
  cwd: string | null = null,
): SessionContextBill {
  const ledger = new ContextLedger(agentId, cwd);
  for (const e of entries) ledger.add(e.request, e.detail);
  return ledger.bill();
}
