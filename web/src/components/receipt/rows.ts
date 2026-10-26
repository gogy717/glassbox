/**
 * Lines the image and the text both print, built once so that the two always say the same: TIME's
 * rows with their shares, and the tool categories folded to fit.
 */
import type { TestVerdict } from '../../../../src/shared/outcome.js';
import { type Locale, type MessageKey, translate } from '../../i18n';
import type { ReceiptData } from './data';
import { type ReceiptKey, rt } from './strings';

/**
 * `units` whole units shared out in proportion to `values`, adding up to exactly `units`: each
 * takes its floor, and the units left go to the largest remainders (rounding each alone can
 * give one more or one less).
 */
export function apportion(values: number[], units: number): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v / total) * units);
  const out = exact.map((e) => Math.floor(e));
  let left = units - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    left--;
  }
  return out;
}

/** Whole percents of `values` that add up to exactly 100. */
export const shares = (values: number[]) => apportion(values, 100);

export interface TimeRow {
  key: ReceiptKey;
  ms: number;
  /** A whole percent of what TIME prints; the rows add up to 100. */
  share: number;
}

/** TIME's rows: the Timeline's figures, a kind under a second left out. */
export function timeRows(d: ReceiptData): TimeRow[] {
  const kinds = (
    [
      ['thinking', d.time.thinking],
      ['generating', d.time.generating],
      ['tools', d.time.tools],
      ['approval', d.time.approval],
      ['queued', d.time.queued],
    ] as [ReceiptKey, number][]
  ).filter(([, ms]) => ms >= 1000);
  const pct = shares(kinds.map(([, ms]) => ms));
  return kinds.map(([key, ms], i) => ({ key, ms, share: pct[i] ?? 0 }));
}

/** Whether TIME has anything to print besides the barcode. */
export const timed = (d: ReceiptData) => timeRows(d).length > 0 || d.time.longestThink >= 1000;

/**
 * The tool categories as one line ("explore 72 · edit 41 · run 29 · other 6"), the smallest
 * named one folded into other until the line `fits`: it never wraps and never runs off.
 */
export function categoryLine(
  categories: ReceiptData['work']['categories'],
  locale: Locale,
  fits: (line: string) => boolean,
  figure: (n: number) => string = String,
): string {
  const name = (category: string) => {
    const word = translate(locale, `steps.cat.${category}` as MessageKey);
    return locale === 'en' ? word.toLowerCase() : word;
  };
  const render = (list: typeof categories) =>
    list.map(({ category, count }) => `${name(category)} ${figure(count)}`).join(' · ');
  let list = [...categories];
  while (!fits(render(list))) {
    const named = list.filter((c) => c.category !== 'other');
    const smallest = named.at(-1);
    if (!smallest) break;
    const other = (list.find((c) => c.category === 'other')?.count ?? 0) + smallest.count;
    list = [...named.slice(0, -1), { category: 'other', count: other }];
  }
  return render(list);
}

/** The last run's verdict on WORK's test line, when it is known. */
const LAST: Partial<Record<TestVerdict, ReceiptKey>> = {
  passed: 'lastPassed',
  failed: 'lastFailed',
  running: 'lastRunning',
};

/** WORK's test line after its count: "Test runs · last ✓". */
export function testRunWords(tests: { runs: number; verdict: TestVerdict }, locale: Locale) {
  const words = rt(locale, 'testRuns', { n: tests.runs });
  const last = LAST[tests.verdict];
  return last ? `${words} · ${rt(locale, last)}` : words;
}

/** `s` cut to `width` by `measure`, ending in "…" when it was longer. */
export function clip(s: string, width: number, measure: (s: string) => number): string {
  if (measure(s) <= width) return s;
  let cut = [...s];
  while (cut.length > 0 && measure(`${cut.join('')}…`) > width) cut = cut.slice(0, -1);
  return `${cut.join('').trimEnd()}…`;
}
