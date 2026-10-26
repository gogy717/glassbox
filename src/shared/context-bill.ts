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
import type { ModelRequest, RequestDetail } from '../core/model.js';
import { type Block, isGap, readMessage, readSystem, readTools } from './request-read.js';
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
  missing?: { messages: number; system: boolean; tools: boolean };
  /** Tokens as its characters suggest. */
  weight: number;
  /** Estimated tokens: the request's total spread by weight. */
  tokens: number;
  /** `tokens` by kind, by where the part sits; null when the request reported no total. */
  split: TokenSplit | null;
}

/**
 * Why there is no bill: the request body was not recorded (an older Claude Code, an agent that
 * keeps none), only its system prompt and tools were (Codex, oh-my-pi), or it holds nothing.
 */
export type BillUnavailable = 'not-recorded' | 'no-messages' | 'empty';

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
      return textTokens(b.name);
    case 'raw':
      return jsonTokens(b.value);
  }
}

/** Opening words: the first line with text, clipped. */
const OPENING_MAX = 80;
function opening(text: string): string | null {
  const line = text
    .slice(0, 2_000)
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > OPENING_MAX ? `${line.slice(0, OPENING_MAX - 1)}…` : line;
}

/** A part as weighed from its message, before a request places it: shared, never changed. */
export interface Weighed {
  kind: PartKind;
  role: string | null;
  tool: string | null;
  callId: string | null;
  /** A call's input, for naming what it works on. */
  input: unknown;
  text: string | null;
  weight: number;
  /** A gap's: messages not reconstructed. */
  gap: number;
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
      out.push(part({ kind: 'result', role, callId: b.toolUseId, weight: blockTokens(b) }));
    } else {
      if (!own) {
        own = part({ kind, role });
        out.push(own);
      }
      own.weight += blockTokens(b);
      if (own.text === null && b.kind === 'text') own.text = opening(b.text);
    }
  }
  return out.filter((p) => p.weight > 0);
}

/** A part placed in one request: its key there, and whether its message is the last. */
export interface Placed {
  w: Weighed;
  key: string;
  last: boolean;
  /** The gap's: what is missing. */
  missing?: { messages: number; system: boolean; tools: boolean };
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
  const missing = { messages: 0, system: false, tools: false };
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
      if (weight > 0) place(part({ kind: 'tool', tool: name, weight }), `tool:${name}`);
    });
  } else {
    const weight = shapeTokens(detail.tools, jsonTokens);
    if (weight > 0) place(part({ kind: 'tool', weight }), 'tool:?');
  }

  if (detail.system === null) {
    missing.system = true;
    addGap();
  } else {
    const weight = shapeTokens(detail.system, systemTokens);
    if (weight > 0) place(part({ kind: 'system', weight }), 'system');
  }

  const messages = detail.messages;
  messages.forEach((raw, i) => {
    const last = i === messages.length - 1;
    for (const w of messageParts(raw)) {
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
  });
  gap.w.gap = missing.messages;
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
 * The parts' estimated tokens: the total spread by weight. With a gap, the known parts keep their
 * own weight (scaled down only if they outweigh the total) and the gap takes the rest.
 */
export function spread(weights: number[], gapAt: number, total: number): number[] {
  const known = weights.reduce((s, w, i) => (i === gapAt ? s : s + w), 0);
  if (known === 0) return weights.map(() => 0);
  const scale = gapAt >= 0 ? Math.min(1, total / known) : total / known;
  const tokens = weights.map((w, i) => (i === gapAt ? 0 : w * scale));
  if (gapAt >= 0) tokens[gapAt] = Math.max(0, total - known * scale);
  return tokens;
}

/** The context bill of one request, from its details. */
export function requestBill(
  request: Pick<ModelRequest, 'hasDetail' | 'usage'>,
  detail: RequestDetail | null,
): RequestBill {
  if (!request.hasDetail || !detail || detail.completeness === 'unavailable')
    return { status: 'unavailable', reason: 'not-recorded' };
  const placed = placeParts(detail);
  if (!placed) return { status: 'unavailable', reason: 'no-messages' };
  const gapAt = placed.findIndex((p) => p.w.kind === 'gap');
  const weights = placed.map((p) => p.w.weight);
  const known = weights.reduce((s, w) => s + w, 0);
  if (known === 0) return { status: 'unavailable', reason: 'empty' };

  const u = request.usage;
  const reported = u ? u.input + u.cacheRead + u.cacheWrite : 0;
  const usage =
    reported > 0 && u ? { cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, input: u.input } : null;
  const total = usage ? reported : known;
  const tokens = spread(weights, gapAt, total);

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
