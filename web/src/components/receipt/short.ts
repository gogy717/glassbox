/**
 * The receipts redrawn for a phone's screen. Post (4:5) and Story (9:16) are not the tall slip
 * shrunk to fit, which a phone cannot read, but a short slip the size of the frame in the tall
 * slip's own type: the head, the title, the headline figures large, one line of work, the
 * barcode (the week's grid on the weekly one) and, with a story's room, time and tokens; the
 * foot at the bottom. What does not fit gives way in a fixed order, the figures never.
 */
import { formatCompact, formatPercent } from '../../lib/format';
import { formatUsd } from '../../lib/prices';
import { BAR_HEIGHT, type BarKind, barcode } from './barcode';
import type { ReceiptData } from './data';
import type { Parts } from './format';
import { clock, serial } from './format';
import {
  EDGE,
  INNER,
  LEFT,
  num,
  type Pen,
  partsBody,
  partsWidth,
  type ReceiptSize,
  RIGHT,
  runs,
  SIZES,
  type TokenFigures,
  text,
  textWidth,
  WIDTH,
} from './slip';
import type { ReceiptKey } from './strings';

/** A short size's frame height, in slip units. */
export const shortHeight = (size: Exclude<ReceiptSize, 'tall'>): number => SIZES[size].h as number;

/** One headline figure: its label (a receipt key) and its value, as parts or a drawn string. */
export interface Figure {
  key: ReceiptKey;
  value: Parts | string;
}

/**
 * The headline figures in a row: labels above, the values large below, the first at the left
 * margin, the last at the right, the middle one between them. Advances `p.y` past the values.
 */
export function figures(p: Pen, items: Figure[]): void {
  const { c } = p;
  const xs =
    items.length === 1
      ? [LEFT]
      : items.length === 2
        ? [LEFT, RIGHT]
        : [LEFT, LEFT + INNER * 0.42, RIGHT];
  const anchorOf = (i: number): 'start' | 'end' | 'middle' =>
    i === items.length - 1 && items.length > 1 ? 'end' : 'start';
  // The middle figure may not run into the last: it moves left as far as it must. A column is
  // as wide as its label or its value, whichever is wider.
  const zh = p.L === 'zh';
  const widths = items.map((it) =>
    Math.max(
      typeof it.value === 'string' ? textWidth(it.value, 22) : partsWidth(it.value, 22),
      textWidth(zh ? p.w(it.key) : p.w(it.key).toUpperCase(), 10, zh ? 0 : 1.4),
    ),
  );
  if (items.length === 3) {
    const last = widths[2] ?? 0;
    const mid = widths[1] ?? 0;
    const maxMid = RIGHT - last - 14 - mid;
    xs[1] = Math.min(xs[1] as number, Math.max(LEFT + (widths[0] ?? 0) + 14, maxMid));
  }
  p.y += 14;
  items.forEach((it, i) => {
    p.label(it.key, xs[i], anchorOf(i));
  });
  p.y += 22;
  items.forEach((it, i) => {
    const body = typeof it.value === 'string' ? runs(it.value) : partsBody(it.value);
    p.push(
      text(xs[i] as number, p.y, body, { size: 22, weight: 500, fill: c.ink, anchor: anchorOf(i) }),
    );
  });
}

/** TOKENS in brief: the share bar and the four kinds with the cache hit, no total (shown large). */
export function tokensBrief(p: Pen, t: TokenFigures): void {
  const { c, L } = p;
  const figure = (s: string): Parts => [{ digits: s, unit: '' }];
  p.y += 16;
  p.label('tokens');
  if (!t.measured) {
    p.y += 18;
    p.push(text(LEFT, p.y, runs(p.w('notReported')), { fill: c.soft }));
    return;
  }
  p.y += 12;
  const shares = [t.cacheRead, t.cacheWrite, t.uncached, t.output];
  const sum = shares.reduce((a, b) => a + b, 0);
  const opacity = [1, 0.55, 0.35, 0.2];
  let x = LEFT;
  shares.forEach((v, i) => {
    const bw = sum > 0 ? (v / sum) * INNER : 0;
    if (bw > 0)
      p.push(
        `<rect x="${num(x)}" y="${num(p.y)}" width="${num(bw)}" height="3.5" fill="${c.ink}" fill-opacity="${opacity[i]}"/>`,
      );
    x += bw;
  });
  p.y += 4;
  const row = (key: ReceiptKey, v: number) => {
    if (v <= 0) return;
    p.y += 17;
    p.row(p.w(key), figure(formatCompact(v, L)));
  };
  row('cacheRead', t.cacheRead);
  row('cacheWrite', t.cacheWrite);
  row('uncached', t.uncached);
  row('output', t.output);
  if (t.cacheHit !== null) {
    p.y += 17;
    p.row(p.w('cacheHit'), figure(formatPercent(t.cacheHit, L)));
  }
}

/** The tokens' headline: the total when measured, "—" when not; and the API equivalent. */
export const totalFigure = (p: Pen, t: TokenFigures): Figure => ({
  key: 'total',
  value: t.measured ? formatCompact(t.total, p.L) : '—',
});
export const costFigure = (t: TokenFigures): Figure | null =>
  t.cost.priced ? { key: 'apiEquiv', value: `≈ ${formatUsd(t.cost.usd, 'en')}` } : null;

/**
 * The barcode block: the session's own timeline, its breaks and sub-agent tracks, the start and
 * end under it and the serial line. Nothing when there is nothing to draw. Advances `p.y`.
 */
export function drawBarcode(p: Pen, d: ReceiptData): boolean {
  const { c } = p;
  const code = barcode(d.segments, d.subAgents, d.failedTools, INNER, d.subSegments);
  if (code.bars.length === 0 && code.tracks.length === 0) return false;
  const bottom = p.y + 12 + 42;
  const ink = (k: BarKind) => (k === 'fail' ? c.fail : k === 'approval' ? c.soft : c.ink);
  for (const b of code.bars) {
    const h = BAR_HEIGHT[b.kind];
    p.push(
      `<rect x="${num(LEFT + b.x)}" y="${num(bottom - h)}" width="${num(b.w)}" height="${h}" fill="${ink(b.kind)}"/>`,
    );
  }
  for (const x of code.breaks)
    p.push(
      `<path d="M${num(LEFT + x - 3)} ${num(bottom + 3)} l2 -6 M${num(LEFT + x + 1)} ${num(bottom + 3)} l2 -6" stroke="${c.soft}" stroke-width="1"/>`,
    );
  let ty = bottom + 6;
  code.tracks.forEach((t, i) => {
    p.push(
      `<rect x="${num(LEFT + t.x)}" y="${num(ty)}" width="${num(t.w)}" height="2" fill="${c.soft}"/>`,
    );
    // "+N" just before the merged track's start (in the margin if need be), else after its end,
    // else under its start: never past the paper's edge.
    if (i === code.tracks.length - 1 && code.more > 0) {
      const label = `+${code.more}`;
      const lw = textWidth(label, 9);
      const before = LEFT + t.x - 4;
      const after = LEFT + t.x + t.w + 4;
      const style = { size: 9, fill: c.soft };
      if (before - lw >= EDGE)
        p.push(text(before, ty + 3, runs(label), { ...style, anchor: 'end' }));
      else if (after + lw <= WIDTH - EDGE) p.push(text(after, ty + 3, runs(label), style));
      else {
        ty += 10;
        p.push(text(Math.min(LEFT + t.x, WIDTH - EDGE - lw), ty + 3, runs(label), style));
      }
    }
    ty += 4;
  });
  p.y = ty + 14;
  p.push(
    text(LEFT, p.y, runs(d.start !== null ? clock(d.start) : ''), { size: 10.5, fill: c.soft }),
  );
  p.push(
    text(RIGHT, p.y, runs(d.running ? p.w('now') : clock(d.end)), {
      size: 10.5,
      fill: c.soft,
      anchor: 'end',
    }),
  );
  p.y += 17;
  p.serial(serial(d.nativeId, d.start, d.end));
  return true;
}

/**
 * Where the foot's first baseline sits so that its last line's baseline is 14 units above
 * `height`: clear of the teeth, no more.
 */
export const footTop = (height: number, measured: boolean): number =>
  height - 14 - 18 - (measured ? 18 : 0);

/**
 * Finishes a short slip: true when the content ends above the foot (with `gap` to spare), the
 * foot drawn at the bottom either way so a slip that did not fit still reads to its end.
 */
export function finish(p: Pen, height: number, measured: boolean, gap = 18): boolean {
  const top = footTop(height, measured);
  const fits = p.y + gap <= top;
  p.y = top;
  p.foot(measured, 0);
  return fits;
}
