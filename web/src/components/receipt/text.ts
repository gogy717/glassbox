/**
 * The receipt as text, for a PR, a stand-up or a chat: a fenced block of at most 40 lines and 44
 * columns, one line per line of the image (the barcode aside). Its figures are always ASCII
 * ("1h 02m", "18.2M"); in Chinese they come first on a line and the words after them, because a
 * CJK character's width in a code font varies (about 1.7 columns on GitHub) and nothing after
 * one can be aligned.
 */
import type { Locale } from '../../i18n';
import { agentName } from '../../lib/agent-names';
import { formatCompact, formatPercent } from '../../lib/format';
import { formatUsd } from '../../lib/prices';
import type { ReceiptData } from './data';
import { clock, day, durationParts, modelName, partsText } from './format';
import { clean } from './printed';
import { categoryLine, clip, noPriceLine, timed, timeRows } from './rows';
import type { ReceiptOptions, TokenFigures } from './slip';
import { type ReceiptKey, rt } from './strings';

/** Columns of the block. */
export const COLUMNS = 44;
const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;
const TOKENS = /[⺀-鿿豈-﫿＀-￯　-〿]|[^\s⺀-鿿豈-﫿＀-￯　-〿]+|\s+/g;

/** Display width, counting a CJK character as two columns (the widest a code font gives it). */
export const cols = (s: string) => [...s].reduce((n, ch) => n + (CJK.test(ch) ? 2 : 1), 0);

export const spread = (left: string, right: string, fill = ' ') =>
  `${left}${fill.repeat(Math.max(1, COLUMNS - cols(left) - cols(right)))}${right}`;

/** `left`, a run of dots, then `right`, ending at column `width`. */
export const dots = (left: string, right: string, width = COLUMNS) =>
  `${left}${'.'.repeat(Math.max(1, width - cols(left) - cols(right)))}${right}`;

/**
 * `s` in lines of at most COLUMNS, broken between words or CJK characters (a word longer than a
 * line is broken inside it, never dropped), `max` lines, the last ending in "…" when cut.
 */
export function wrapCols(s: string, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const tok of s.match(TOKENS) ?? []) {
    if (/^\s+$/.test(tok)) {
      if (line) line += ' ';
      continue;
    }
    if (cols(line + tok) <= COLUMNS) {
      line += tok;
      continue;
    }
    if (line.trim()) lines.push(line.trimEnd());
    line = '';
    for (const ch of tok) {
      if (cols(line + ch) > COLUMNS) {
        lines.push(line);
        line = '';
      }
      line += ch;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max - 1), clip(`${lines[max - 1]}…`, COLUMNS, cols)];
}

/** Chinese: the figure in a 7-column field, then the words (R9: nothing CJK before a figure). */
export const lead = (figure: string, words: string, gap = '  ') =>
  `${figure.padStart(7)}${gap}${words}`;

/** A line centred in the block. */
export const centred = (line: string) =>
  `${' '.repeat(Math.max(0, Math.floor((COLUMNS - cols(line)) / 2)))}${line}`;

/**
 * TOKENS as text lines, `note` under the rows, the API equivalent under TOTAL; "Tokens not
 * reported" when no call reported.
 */
export function tokenLines(t: TokenFigures, L: Locale, note?: string): string[] {
  const zh = L === 'zh';
  const w = (key: ReceiptKey) => rt(L, key);
  const head = (key: ReceiptKey) => (zh ? w(key) : w(key).toUpperCase());
  const count = (n: number) => formatCompact(n, 'en');
  const out = [head('tokens')];
  if (!t.measured) return [...out, w('notReported')];
  const row = (key: ReceiptKey, figure: string, indent = '') =>
    out.push(zh ? lead(figure, `${indent}${w(key)}`) : dots(`${indent}${w(key)} `, ` ${figure}`));
  if (t.cacheRead > 0) row('cacheRead', count(t.cacheRead));
  if (t.cacheWrite > 0) row('cacheWrite', count(t.cacheWrite));
  if (t.uncached > 0) row('uncached', count(t.uncached));
  if (t.output > 0) row('output', count(t.output));
  if (t.thinking > 0) row('ofThinking', count(t.thinking), '  ');
  if (t.cacheHit !== null) row('cacheHit', formatPercent(t.cacheHit, 'en'));
  if (note) out.push(note);
  out.push(zh ? lead(count(t.total), w('total')) : spread(head('total'), count(t.total)));
  // API EQUIV.: the same tokens at API prices, an estimate; the models it could not price.
  if (t.cost.priced) {
    const usd = `≈ ${formatUsd(t.cost.usd, 'en')}`;
    out.push(
      zh ? lead(usd, `${w('apiEquiv')}${w('est')}`) : spread(head('apiEquiv'), `${usd}${w('est')}`),
    );
    const unpriced = noPriceLine(t.cost, L, (line) => cols(line) <= COLUMNS);
    if (unpriced) out.push(unpriced);
  }
  return out;
}

/** The foot as text: "Every token accounted for" only when the tokens were. */
export const footLines = (L: Locale, measured: boolean) =>
  [rt(L, 'printedBy'), 'npx github:gogy717/glassbox', ...(measured ? [rt(L, 'motto')] : [])].map(
    centred,
  );

/** Lines of the block, fences included (R7). */
const MAX_LINES = 40;

export function receiptText(d: ReceiptData, o: ReceiptOptions): string {
  let titleLines = 3;
  let lines = textLines(d, o, titleLines);
  // Over 40 lines (the most a receipt can print): the title gives up lines, one at a time, down
  // to one, whatever it wrapped to.
  while (lines.length > MAX_LINES && titleLines > 1) lines = textLines(d, o, --titleLines);
  // Well formed whatever the session holds: a lone surrogate would not survive the clipboard.
  return clean(lines.join('\n'));
}

/** The receipt's lines, its title in at most `titleLines`. */
function textLines(d: ReceiptData, o: ReceiptOptions, titleLines: number): string[] {
  const L = o.locale;
  const zh = L === 'zh';
  const w = (key: ReceiptKey, params?: Record<string, string | number>) => rt(L, key, params);
  const head = (key: ReceiptKey) => (zh ? w(key) : w(key).toUpperCase());
  // Figures in ASCII whatever the language: they are what has to line up.
  const dur = (ms: number) => partsText(durationParts(ms, 'en'));
  const rule = '-'.repeat(COLUMNS);
  const out: string[] = ['```'];

  out.push(zh ? `glassbox · ${w('heading')}` : spread('glassbox', head('heading')));
  const who = [
    agentName(d.agent),
    d.model ? modelName(d.model) : null,
    d.effort ? w('effort', { e: d.effort }) : null,
  ];
  out.push(clip(who.filter(Boolean).join(' · '), COLUMNS, cols));
  const span = d.running
    ? `${d.start !== null ? `${clock(d.start)} ` : ''}→ ${w('now')} · ${w('stillRunning')}`
    : d.start !== null
      ? `${clock(d.start)} – ${clock(d.end)}`
      : clock(d.end);
  // A running session's line can outgrow the block: "still running" then joins the duration.
  const when = `${day(d.start ?? d.end, L)} · ${span}`;
  const tail = ` · ${w('stillRunning')}`;
  const moved = d.running && cols(when) > COLUMNS;
  out.push(moved ? when.slice(0, -tail.length) : when);
  const duration = d.durationMs === null ? '—' : dur(d.durationMs);
  const durationName = moved ? `${head('duration')}${tail}` : head('duration');
  out.push(zh ? lead(duration, durationName) : spread(durationName, duration));
  out.push(rule);
  if (!o.hideNames && d.project) out.push(`${clip(d.project, COLUMNS - 2, cols)} /`);
  out.push(...wrapCols(o.hideNames || !d.title ? w('untitled') : d.title, titleLines));
  out.push(rule);

  out.push(head('work'));
  const work = (n: number, key: ReceiptKey) => {
    if (n > 0) out.push(`${String(n).padStart(5)}  ${w(key, { n })}`);
  };
  work(d.work.requests, 'modelCalls');
  work(d.work.toolCalls, 'toolCalls');
  if (d.work.toolCalls > 0 && d.work.categories.length > 0)
    out.push(`       ${categoryLine(d.work.categories, L, (line) => cols(line) <= COLUMNS - 7)}`);
  work(d.work.subAgents, 'subAgents');
  work(d.work.turns, 'prompts');
  work(d.work.failures, 'failures');
  work(d.work.compactions, 'compactions');
  out.push(rule);

  if (timed(d)) {
    out.push(head('time'));
    for (const r of timeRows(d))
      out.push(
        zh
          ? lead(dur(r.ms), `${`${r.share}%`.padStart(4)}  ${w(r.key)}`)
          : `${dots(`${w(r.key)} `, ` ${dur(r.ms)}`, COLUMNS - 5)}${`${r.share}%`.padStart(5)}`,
      );
    if (d.time.longestThink >= 1000) {
      const v = dur(d.time.longestThink);
      out.push(
        zh
          ? lead(v, w('longestThink'), '        ')
          : dots(`${w('longestThink')} `, ` ${v}`, COLUMNS - 5),
      );
    }
    out.push(rule);
  }

  out.push(...tokenLines(d.tokens, L));
  out.push(...footLines(L, d.tokens.measured));
  out.push('```');
  return out;
}
