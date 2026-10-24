/**
 * The receipt as text, for a PR, a stand-up or a chat: a fenced block, one line per line of the
 * image (the barcode aside), aligned with spaces at most 40 lines long. CJK counts two columns.
 */
import { type MessageKey, translate } from '../../i18n';
import { agentName } from '../../lib/agent-names';
import { formatCompact } from '../../lib/format';
import type { ReceiptData } from './data';
import { clock, day, durationParts, modelName, partsText, percent } from './format';
import { type ReceiptKey, rt } from './strings';
import type { ReceiptOptions } from './svg';

/** Columns of the block. */
export const COLUMNS = 44;
const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

/** Display width: a CJK character takes two columns. */
export const cols = (s: string) => [...s].reduce((n, ch) => n + (CJK.test(ch) ? 2 : 1), 0);

const spread = (left: string, right: string, fill = ' ') =>
  `${left}${fill.repeat(Math.max(1, COLUMNS - cols(left) - cols(right)))}${right}`;

/** `s` in lines of at most COLUMNS, broken between words or CJK characters, `max` lines. */
function wrapCols(s: string, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const tok of s.match(/[⺀-鿿豈-﫿＀-￯　-〿]|[^\s⺀-鿿豈-﫿＀-￯　-〿]+|\s+/g) ?? []) {
    if (/^\s+$/.test(tok)) {
      if (line) line += ' ';
    } else if (cols(line + tok) <= COLUMNS) line += tok;
    else {
      if (line.trim()) lines.push(line.trimEnd());
      line = [...tok].reduce((acc, ch) => (cols(acc + ch) <= COLUMNS ? acc + ch : acc), '');
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  if (lines.length <= max) return lines;
  let last = lines[max - 1] as string;
  while (cols(`${last}…`) > COLUMNS) last = [...last].slice(0, -1).join('');
  return [...lines.slice(0, max - 1), `${last}…`];
}

export function receiptText(d: ReceiptData, o: ReceiptOptions): string {
  const L = o.locale;
  const w = (key: ReceiptKey, params?: Record<string, string | number>) => rt(L, key, params);
  const head = (key: ReceiptKey) => (L === 'zh' ? w(key) : w(key).toUpperCase());
  const dur = (ms: number) => partsText(durationParts(ms, L));
  const rule = '-'.repeat(COLUMNS);
  const out: string[] = ['```'];

  out.push(spread('glassbox', head('heading')));
  out.push(
    [
      agentName(d.agent),
      d.model ? modelName(d.model) : null,
      d.effort ? w('effort', { e: d.effort }) : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
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
  out.push(
    spread(
      moved ? `${head('duration')}${tail}` : head('duration'),
      d.durationMs === null ? '—' : dur(d.durationMs),
    ),
  );
  out.push(rule);
  if (!o.hideNames && d.project) out.push(`${d.project} /`);
  out.push(...wrapCols(o.hideNames || !d.title ? w('untitled') : d.title, 3));
  out.push(rule);

  out.push(head('work'));
  const count = (n: number, key: ReceiptKey) => {
    if (n > 0) out.push(`${String(n).padStart(5)}  ${w(key, { n })}`);
  };
  count(d.work.requests, 'modelCalls');
  count(d.work.toolCalls, 'toolCalls');
  if (d.work.toolCalls > 0 && d.work.categories.length > 0)
    out.push(
      `       ${d.work.categories
        .map(({ category, count }) => {
          const name = translate(L, `steps.cat.${category}` as MessageKey);
          return `${L === 'en' ? name.toLowerCase() : name} ${count}`;
        })
        .join(' · ')}`,
    );
  count(d.work.subAgents, 'subAgents');
  count(d.work.turns, 'conversations');
  count(d.work.failures, 'failures');
  count(d.work.compactions, 'compactions');
  out.push(rule);

  const parts = (
    [
      ['thinking', d.time.thinking],
      ['generating', d.time.generating],
      ['tools', d.time.tools],
      ['approval', d.time.approval],
      ['queued', d.time.queued],
    ] as [ReceiptKey, number][]
  ).filter(([, v]) => v >= 1000);
  const whole = parts.reduce((s, [, v]) => s + v, 0);
  // Left out when nothing was timed, as on the image (the barcode is the image's alone).
  const timed = parts.length > 0 || d.time.longestThink >= 1000;
  if (timed) out.push(head('time'));
  for (const [key, v] of parts)
    out.push(
      `${spreadTo(`${w(key)} `, ` ${dur(v)}`, COLUMNS - 5)}${percent(v / whole).padStart(5)}`,
    );
  if (d.time.longestThink >= 1000)
    out.push(spreadTo(`${w('longestThink')} `, ` ${dur(d.time.longestThink)}`, COLUMNS - 5));
  if (timed) out.push(rule);

  out.push(head('tokens'));
  const t = d.tokens;
  if (!t.measured) out.push(w('notReported'));
  else {
    const c = (n: number) => formatCompact(n, L);
    const tokenRow = (key: ReceiptKey, v: number, indent = '') => {
      if (v > 0) out.push(spread(`${indent}${w(key)} `, ` ${c(v)}`, '.'));
    };
    tokenRow('cacheRead', t.cacheRead);
    tokenRow('cacheWrite', t.cacheWrite);
    tokenRow('uncached', t.uncached);
    tokenRow('output', t.output);
    tokenRow('ofThinking', t.thinking, '  ');
    if (t.cacheHit !== null) out.push(spread(`${w('cacheHit')} `, ` ${percent(t.cacheHit)}`, '.'));
    out.push(spread(head('total'), c(t.total)));
  }

  for (const line of [w('printedBy'), 'npx github:gogy717/glassbox', w('motto')])
    out.push(`${' '.repeat(Math.max(0, Math.floor((COLUMNS - cols(line)) / 2)))}${line}`);
  out.push('```');
  return out.join('\n');
}

/** `left`, a run of dots, then `right`, ending at column `width`. */
function spreadTo(left: string, right: string, width: number): string {
  return `${left}${'.'.repeat(Math.max(1, width - cols(left) - cols(right)))}${right}`;
}
