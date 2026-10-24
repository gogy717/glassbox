/** Why a model call did what it did, in one sentence under its call line. */
import type { IsoTime, ModelRequest, ToolCall } from '../../../../src/core/model.js';
import { plainText } from '../../lib/preview';

/** Two lines of the call's width hold about this much; the rest is in the steps view. */
const MAX = 240;

/**
 * Where a sentence may end: `.` `!` `?` before a space and a capital, a digit or a quote, or at
 * the end; or a CJK full stop. So "e.g. the store", "v2.0" and "src/app.ts" do not end one.
 */
const END = /[.!?](?=\s+[\p{Lu}\p{N}"'“‘(]|\s*$)|[。！？]/gu;

/** Words whose own full stop ends no sentence, even before a capital: "e.g. React", "Dr. Who". */
const ABBREVIATIONS = new Set([
  'e.g',
  'i.e',
  'etc',
  'vs',
  'cf',
  'mr',
  'mrs',
  'ms',
  'dr',
  'st',
  'no',
  'fig',
  'approx',
]);
const WORD_BEFORE = /[\p{L}.]+$/u;

/** The first sentence of plain text, on one line, cut at `MAX` characters if it runs on. */
export function firstSentence(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  let end = s.length;
  for (const m of s.matchAll(END)) {
    const word = WORD_BEFORE.exec(s.slice(0, m.index))?.[0].toLowerCase();
    if (m[0] === '.' && word && ABBREVIATIONS.has(word)) continue;
    end = m.index + 1;
    break;
  }
  // By code point, so the cut never splits an emoji or another astral character in two.
  const chars = [...s.slice(0, end)];
  return chars.length > MAX ? `${chars.slice(0, MAX).join('')}…` : chars.join('');
}

/**
 * The call's reason: the first sentence of what it said, else of its recorded thinking (the same
 * words the steps view shows in full). Null for a call that only ran tools, or whose thinking was
 * not recorded; never the list of what it did, which its cards already show.
 */
export function whyLine(req: ModelRequest): string | null {
  const said = req.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : [])).join('\n\n');
  const thought = req.blocks
    .flatMap((b) => (b.kind === 'thinking' && b.text ? [b.text] : []))
    .join('\n\n');
  for (const source of [said, thought]) {
    const line = firstLine(source);
    if (line) return firstSentence(line);
  }
  return null;
}

const FENCE = /^\s*(```|~~~)/;

/** The first line with words, as plain text: a line break ends a sentence, code is skipped. */
function firstLine(markdown: string): string | null {
  let inFence = false;
  for (const line of markdown.slice(0, 4_000).split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence) {
      const plain = plainText(line);
      if (plain) return plain;
    }
  }
  return null;
}

const ms = (t: IsoTime | null): number => {
  const v = t === null ? Number.NaN : Date.parse(t);
  return Number.isNaN(v) ? Number.NEGATIVE_INFINITY : v;
};

/**
 * Where a call in flight's "Thinking · m:ss" clock starts: the end of the latest of its own
 * tools, else the call's start, so a call that spans its tools (Codex, Grok, OpenCode) does not
 * jump back to its start once a tool ends. The same rule as `thinkingSince` in
 * src/core/activity.ts (branch v2-w6-activity); use that once both are merged.
 */
export function thinkingSince(call: ModelRequest, tools: Iterable<ToolCall>): IsoTime | null {
  const own = new Set(call.toolCallIds);
  let since = call.startedAt;
  for (const t of tools)
    if (own.has(t.id) && t.endedAt !== null && ms(t.endedAt) > ms(since)) since = t.endedAt;
  return since;
}

/**
 * The thinking clock's start for a call in flight that is waiting on the model; null while one
 * of its own tools runs (that is the tool's time, on its card, as `sessionActivity` has it), or
 * once the call has ended.
 */
export function thinkingClock(call: ModelRequest, tools: Iterable<ToolCall>): IsoTime | null {
  if (call.status !== 'in-flight') return null;
  const own = new Set(call.toolCallIds);
  for (const t of tools) if (own.has(t.id) && t.status === 'running') return null;
  return thinkingSince(call, tools);
}
