/**
 * Search inside a session: everything the page holds for one agent, matched as one types. The
 * prompts, the replies' text, each tool's input (its one-line summary and its raw JSON) and its
 * result preview. Full results are fetched on demand and are not searched.
 */
import type { ModelRequest, ToolCall, Turn } from '../../../../src/core/model.js';
import type { OpenSession } from '../../data/store';
import { summarizeInput } from '../../lib/tool-category';
import type { CardKey } from '../../router';
import { requestsOf, toolsOf, turnsOf } from './flow-model';

/** What a hit is in: the prompt, a reply, a tool's input, or its result preview. */
export type HitKind = 'prompt' | 'reply' | 'tool' | 'result';

export interface SearchHit {
  kind: HitKind;
  /** The tool's name, for an input or a result. */
  tool: string | null;
  /** Where the hit is: the call (null for the prompt) and its card that shows it. */
  requestId: string | null;
  card: CardKey | null;
  /** The first match, as written, with up to `CONTEXT` characters either side ("…" where cut). */
  before: string;
  match: string;
  after: string;
}

export interface SearchGroup {
  turn: Turn;
  /** In page order: the prompt, then each call's reply and its tools' inputs and results. */
  hits: SearchHit[];
}

/** Shorter queries search nothing: one character matches nearly everything. */
export const MIN_QUERY = 2;

/** Characters of context either side of a match. */
const CONTEXT = 40;

/** Whitespace collapsed, so a hit reads on one line and a query matches across a line break. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Each text made searchable once: entities are replaced, not changed, when a patch arrives. */
const lines = new WeakMap<object, string[]>();

function cachedLines(of: object, make: () => string[]): string[] {
  let l = lines.get(of);
  if (!l) {
    l = make().map(oneLine);
    lines.set(of, l);
  }
  return l;
}

/** The input as recorded; '' for one too deep to serialise (adapters keep those). */
function rawJson(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}

/** A tool's summary line, its raw input and its result preview. */
const toolLines = (t: ToolCall) =>
  cachedLines(t, () => [summarizeInput(t), rawJson(t.input), t.resultPreview ?? '']);

const replyLine = (r: ModelRequest) =>
  cachedLines(r, () => [r.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : [])).join(' ')])[0];

const promptLine = (t: Turn) => cachedLines(t, () => [t.prompt])[0];

const isHigh = (c: number) => (c & 0xfc00) === 0xd800;
const isLow = (c: number) => (c & 0xfc00) === 0xdc00;

/** Where `n` characters before `end` begin: code points, so an emoji is never cut in two. */
function backBy(s: string, end: number, n: number): number {
  let i = end;
  for (let k = 0; k < n && i > 0; k++)
    i -= i > 1 && isLow(s.charCodeAt(i - 1)) && isHigh(s.charCodeAt(i - 2)) ? 2 : 1;
  return i;
}

/** Where `n` characters after `start` end. */
function forwardBy(s: string, start: number, n: number): number {
  let i = start;
  for (let k = 0; k < n && i < s.length; k++)
    i += i + 1 < s.length && isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1)) ? 2 : 1;
  return i;
}

type Snippet = Pick<SearchHit, 'before' | 'match' | 'after'>;

/** The first match of `re` in `text`, with its context; null without one. */
function snippet(text: string, re: RegExp): Snippet | null {
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index;
  const end = start + m[0].length;
  const from = backBy(text, start, CONTEXT);
  const to = forwardBy(text, end, CONTEXT);
  return {
    before: `${from > 0 ? '…' : ''}${text.slice(from, start)}`,
    match: m[0],
    after: `${text.slice(end, to)}${to < text.length ? '…' : ''}`,
  };
}

/** `s` as a pattern that matches exactly it. */
const literal = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/**
 * The hits of one entity for one query, remembered until the query changes: a live session is
 * searched again on every patch, and only what the patch replaced is read again.
 */
let memo: { query: string; hits: WeakMap<object, SearchHit[]> } = {
  query: '',
  hits: new WeakMap(),
};

function hitsOf(of: object, query: string, find: () => SearchHit[]): SearchHit[] {
  if (memo.query !== query) memo = { query, hits: new WeakMap() };
  let h = memo.hits.get(of);
  if (!h) {
    h = find();
    memo.hits.set(of, h);
  }
  return h;
}

function toolHits(t: ToolCall, re: RegExp): SearchHit[] {
  const [summary = '', json = '', result = ''] = toolLines(t);
  const where = { tool: t.name, requestId: t.requestId, card: `tool:${t.id}` as const };
  const input = snippet(summary, re) ?? snippet(json, re);
  const output = snippet(result, re);
  return [
    ...(input ? [{ kind: 'tool' as const, ...where, ...input }] : []),
    ...(output ? [{ kind: 'result' as const, ...where, ...output }] : []),
  ];
}

/** Whether `query` is long enough to search: `MIN_QUERY` characters, spaces around them aside. */
export const searchable = (query: string) => [...oneLine(query)].length >= MIN_QUERY;

/**
 * The agent's prompts that hold `query` (case-insensitive, whitespace as one space), in the
 * order of the prompts, each with its hits. A query that is not `searchable` finds nothing.
 */
export function searchSession(open: OpenSession, agentId: string, query: string): SearchGroup[] {
  if (!searchable(query)) return [];
  const q = oneLine(query);
  const re = new RegExp(literal(q), 'i');
  const groups: SearchGroup[] = [];
  for (const turn of turnsOf(open, agentId)) {
    const hits: SearchHit[] = [
      ...hitsOf(turn, q, () => {
        const s = snippet(promptLine(turn) ?? '', re);
        return s ? [{ kind: 'prompt', tool: null, requestId: null, card: null, ...s }] : [];
      }),
    ];
    for (const req of requestsOf(open, turn)) {
      hits.push(
        ...hitsOf(req, q, () => {
          const s = snippet(replyLine(req) ?? '', re);
          return s
            ? [{ kind: 'reply', tool: null, requestId: req.id, card: 'response', ...s }]
            : [];
        }),
      );
      for (const t of toolsOf(open, req)) hits.push(...hitsOf(t, q, () => toolHits(t, re)));
    }
    if (hits.length > 0) groups.push({ turn, hits });
  }
  return groups;
}
