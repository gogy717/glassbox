/**
 * What every receipt is drawn with: a 360-unit-wide slip with toothed edges, in ink on paper (or
 * the reverse at night), failure red its only colour. Latin and figures are set in IBM Plex Mono
 * (embedded, so the image needs nothing from the network); CJK words in the system's UI face,
 * never in mono. The session receipt (`svg.ts`) and the weekly one (`weekSvg.ts`) share the pen,
 * the head, the token block, the foot and the frame.
 */
import type { Locale } from '../../i18n';
import { formatCompact, formatPercent } from '../../lib/format';
import { FONTS } from './fonts';
import type { Parts } from './format';
import { clean } from './printed';
import { type ReceiptKey, rt } from './strings';

export type Paper = 'paper' | 'night';
export type ReceiptSize = 'tall' | 'post' | 'story';
export interface ReceiptOptions {
  paper: Paper;
  locale: Locale;
  hideNames: boolean;
}

/** The slip's width; everything inside sits between the two margins. */
export const WIDTH = 360;
export const LEFT = 22;
export const RIGHT = WIDTH - LEFT;
export const INNER = RIGHT - LEFT;
/** Nothing is drawn nearer the paper's edge than this. */
export const EDGE = 4;
const TOOTH = 6;
const TEETH = 5;

/** Output sizes in slip units; exported at 3× (1080 wide). */
export const SIZES: Record<ReceiptSize, { w: number; h: number | null }> = {
  tall: { w: WIDTH, h: null },
  post: { w: WIDTH, h: 450 },
  story: { w: WIDTH, h: 640 },
};
export const SCALE = 3;

export const INKS: Record<
  Paper,
  { bg: string; ink: string; soft: string; faint: string; fail: string; page: string }
> = {
  paper: {
    bg: '#f7f4ec',
    ink: '#1c1e22',
    soft: '#6a6b6c',
    faint: '#a9a7a1',
    fail: '#b21e25',
    page: '#f3f4f6',
  },
  night: {
    bg: '#1b1c20',
    ink: '#eceef0',
    soft: '#9a9da3',
    faint: '#55585e',
    fail: '#fe8c88',
    page: '#141518',
  },
};

const MONO = '"Receipt Mono", "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
const UI =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif';

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;
const CJK_RUNS = /([⺀-鿿豈-﫿＀-￯　-〿]+)/;

/** Text as XML: well formed, the characters XML forbids dropped, its markup escaped. */
const esc = (s: string) =>
  clean(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
export const num = (n: number) => String(Math.round(n * 100) / 100);

/** Width of `s` at `size`: Plex Mono advances 0.6 em, a CJK character in the UI face about 1 em. */
export function textWidth(s: string, size: number, spacing = 0): number {
  let w = 0;
  for (const ch of s) w += (CJK.test(ch) ? 1 : 0.6) * size + spacing;
  return w;
}

export interface TextStyle {
  size?: number;
  weight?: number;
  fill?: string;
  anchor?: 'start' | 'middle' | 'end';
  /** Letter spacing in units. */
  spacing?: number;
}

/** `s` split into runs: CJK in the UI face, everything else in mono. */
export const runs = (s: string) =>
  s
    .split(CJK_RUNS)
    .filter(Boolean)
    .map((part) => `<tspan font-family='${CJK.test(part) ? UI : MONO}'>${esc(part)}</tspan>`)
    .join('');

export function text(x: number, y: number, body: string, st: TextStyle = {}): string {
  const attrs = [
    `x="${num(x)}"`,
    `y="${num(y)}"`,
    `font-size="${st.size ?? 12}"`,
    st.weight ? `font-weight="${st.weight}"` : '',
    st.fill ? `fill="${st.fill}"` : '',
    st.anchor && st.anchor !== 'start' ? `text-anchor="${st.anchor}"` : '',
    st.spacing ? `letter-spacing="${num(st.spacing)}"` : '',
  ].filter(Boolean);
  return `<text ${attrs.join(' ')}>${body}</text>`;
}

/** A figure with units: digits in mono, units (CJK or not) after them. */
export const partsBody = (p: Parts) => p.map((x) => runs(x.digits) + runs(x.unit)).join('');
export const partsWidth = (p: Parts, size: number) =>
  p.reduce((w, x) => w + textWidth(x.digits, size) + textWidth(x.unit, size), 0);

/**
 * Lines of at most `width`, broken between words (between characters for CJK, or inside a word
 * too long for a line); past `max` lines the last one ends in "…".
 */
export function wrap(s: string, size: number, width: number, max: number): string[] {
  const tokens = s.match(/[⺀-鿿豈-﫿＀-￯　-〿]|[^\s⺀-鿿豈-﫿＀-￯　-〿]+|\s+/g) ?? [];
  const lines: string[] = [];
  let line = '';
  const push = () => {
    lines.push(line.trimEnd());
    line = '';
  };
  for (const tok of tokens) {
    if (/^\s+$/.test(tok)) {
      if (line) line += ' ';
      continue;
    }
    if (textWidth(line + tok, size) <= width) {
      line += tok;
      continue;
    }
    if (line.trim()) push();
    let rest = tok;
    while (textWidth(rest, size) > width) {
      let cut = 0;
      let w = 0;
      for (const ch of rest) {
        w += textWidth(ch, size);
        if (w > width) break;
        cut += ch.length;
      }
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line.trim()) push();
  if (lines.length <= max) return lines;
  let last = lines[max - 1] as string;
  while (last && textWidth(`${last}…`, size) > width) last = [...last].slice(0, -1).join('');
  return [...lines.slice(0, max - 1), `${last.trimEnd()}…`];
}

/** The glassbox mark: a rounded square with a dot, as the app's wordmark. */
const mark = (x: number, y: number, ink: string) =>
  `<rect x="${x + 0.75}" y="${y + 0.75}" width="11.5" height="11.5" rx="2.5" fill="none" stroke="${ink}" stroke-width="1.5"/><circle cx="${x + 6.5}" cy="${y + 6.5}" r="2.2" fill="none" stroke="${ink}" stroke-width="1.5"/>`;

/** The slip's outline: straight sides, toothed top and bottom. */
function outline(height: number): string {
  const n = Math.round(WIDTH / TOOTH);
  let d = `M0 ${TEETH}`;
  for (let i = 0; i < n; i++) d += ` L${i * TOOTH + TOOTH / 2} 0 L${(i + 1) * TOOTH} ${TEETH}`;
  d += ` L${WIDTH} ${height - TEETH}`;
  for (let i = n; i > 0; i--)
    d += ` L${i * TOOTH - TOOTH / 2} ${height} L${(i - 1) * TOOTH} ${height - TEETH}`;
  return `${d} Z`;
}

/** What a receipt's TOKENS block prints. */
export interface TokenFigures {
  measured: boolean;
  cacheRead: number;
  cacheWrite: number;
  uncached: number;
  output: number;
  thinking: number;
  cacheHit: number | null;
  total: number;
}

/** Draws a slip top to bottom: `y` is the baseline of the line being drawn. */
export class Pen {
  readonly out: string[] = [];
  y = 0;
  readonly c: (typeof INKS)[Paper];
  readonly L: Locale;

  constructor(readonly o: ReceiptOptions) {
    this.c = INKS[o.paper];
    this.L = o.locale;
  }

  w(key: ReceiptKey, params?: Record<string, string | number>): string {
    return rt(this.L, key, params);
  }

  push(...parts: string[]): void {
    this.out.push(...parts);
  }

  rule(dashed = true): void {
    const { c, y } = this;
    this.push(
      `<line x1="${LEFT}" y1="${num(y)}" x2="${RIGHT}" y2="${num(y)}" stroke="${dashed ? c.soft : c.ink}" stroke-width="1"${dashed ? ' stroke-dasharray="3 3"' : ''}/>`,
    );
  }

  /** A section label: small caps of a printed form; Chinese has no case and no tracking. */
  label(key: ReceiptKey, at = LEFT, anchor: TextStyle['anchor'] = 'start'): void {
    const zh = this.L === 'zh';
    this.push(
      text(at, this.y, runs(zh ? this.w(key) : this.w(key).toUpperCase()), {
        size: 10,
        fill: this.c.soft,
        anchor,
        spacing: zh ? 0 : 1.4,
      }),
    );
  }

  leader(x0: number, x1: number): void {
    if (x1 - x0 > 8)
      this.push(
        `<line x1="${num(x0)}" y1="${num(this.y - 3)}" x2="${num(x1)}" y2="${num(this.y - 3)}" stroke="${this.c.faint}" stroke-width="1" stroke-dasharray="1 2.5"/>`,
      );
  }

  /** label ........ value  [share]: the value right at `valueRight`, the share at the margin. */
  row(
    name: string,
    value: Parts,
    st: { size?: number; fill?: string; share?: string; valueRight?: number; indent?: number } = {},
  ): void {
    const { c, y } = this;
    const size = st.size ?? 12;
    const x = LEFT + (st.indent ?? 0);
    const right = st.valueRight ?? RIGHT;
    this.push(text(x, y, runs(name), { size, fill: st.fill ?? c.ink }));
    this.push(text(right, y, partsBody(value), { size, fill: st.fill ?? c.ink, anchor: 'end' }));
    if (st.share) this.push(text(RIGHT, y, runs(st.share), { size, fill: c.soft, anchor: 'end' }));
    this.leader(x + textWidth(name, size) + 6, right - partsWidth(value, size) - 6);
  }

  /** The head: the mark and name, the receipt's name at the right, a rule. */
  head(name: ReceiptKey): void {
    this.y = 39;
    this.push(mark(LEFT, this.y - 11, this.c.ink));
    this.push(
      text(LEFT + 18, this.y, runs('glassbox'), { size: 15, weight: 500, fill: this.c.ink }),
    );
    this.label(name, RIGHT, 'end');
    this.y = 60;
    this.rule(false);
  }

  /** The hero line: a section label at the left, the big figure at the right. */
  hero(key: ReceiptKey, value: string): void {
    this.label(key);
    this.push(
      text(RIGHT, this.y + 5, value, { size: 24, weight: 500, fill: this.c.ink, anchor: 'end' }),
    );
  }

  /**
   * TOKENS: what was read and written, unless no call reported usage; `note` is one soft line
   * under the rows, made to fit by the caller (the weekly receipt's sessions that do not report).
   */
  tokens(t: TokenFigures, note?: string): void {
    const { c, L } = this;
    const figure = (s: string): Parts => [{ digits: s, unit: '' }];
    const compact = (n: number) => formatCompact(n, L);
    this.y += 18;
    this.label('tokens');
    if (!t.measured) {
      this.y += 20;
      this.push(text(LEFT, this.y, runs(this.w('notReported')), { fill: c.soft }));
      return;
    }
    this.y += 12;
    const shares = [t.cacheRead, t.cacheWrite, t.uncached, t.output];
    const sum = shares.reduce((a, b) => a + b, 0);
    const opacity = [1, 0.55, 0.35, 0.2];
    let x = LEFT;
    shares.forEach((v, i) => {
      const bw = sum > 0 ? (v / sum) * INNER : 0;
      if (bw > 0)
        this.push(
          `<rect x="${num(x)}" y="${num(this.y)}" width="${num(bw)}" height="3.5" fill="${c.ink}" fill-opacity="${opacity[i]}"/>`,
        );
      x += bw;
    });
    this.y += 4;
    const tokenRow = (key: ReceiptKey, v: number) => {
      if (v <= 0) return;
      this.y += 19;
      this.row(this.w(key), figure(compact(v)));
    };
    tokenRow('cacheRead', t.cacheRead);
    tokenRow('cacheWrite', t.cacheWrite);
    tokenRow('uncached', t.uncached);
    tokenRow('output', t.output);
    if (t.thinking > 0) {
      this.y += 17;
      this.row(this.w('ofThinking'), figure(compact(t.thinking)), {
        size: 11,
        fill: c.soft,
        indent: 14,
      });
    }
    if (t.cacheHit !== null) {
      this.y += 19;
      this.row(this.w('cacheHit'), figure(formatPercent(t.cacheHit, L)));
    }
    if (note) {
      this.y += 17;
      this.push(text(LEFT, this.y, runs(note), { size: 11, fill: c.soft }));
    }
    this.y += 14;
    this.rule(false);
    this.y += 26;
    this.label('total');
    this.push(
      text(RIGHT, this.y + 4, runs(compact(t.total)), {
        size: 24,
        weight: 500,
        fill: c.ink,
        anchor: 'end',
      }),
    );
  }

  /** A centred serial line, as under the barcode. */
  serial(s: string): void {
    this.push(
      text(WIDTH / 2, this.y, runs(s), {
        size: 10.5,
        fill: this.c.soft,
        anchor: 'middle',
        spacing: 1,
      }),
    );
  }

  /** The foot, `gap` under the last line: who printed it, and how to print yours; the height. */
  foot(measured: boolean, gap = 38): number {
    const { c } = this;
    this.y += gap;
    this.push(
      text(WIDTH / 2, this.y, runs(this.w('printedBy')), {
        size: 11,
        fill: c.soft,
        anchor: 'middle',
        spacing: 0.6,
      }),
    );
    this.y += 18;
    this.push(
      text(WIDTH / 2, this.y, runs('npx github:gogy717/glassbox'), {
        size: 11.5,
        fill: c.ink,
        anchor: 'middle',
      }),
    );
    // "Every token accounted for" only when the tokens were.
    if (measured) {
      this.y += 18;
      this.push(
        text(WIDTH / 2, this.y, runs(this.w('motto')), {
          size: 11,
          fill: c.soft,
          anchor: 'middle',
          spacing: 0.6,
        }),
      );
    }
    return Math.ceil(this.y + 30);
  }
}

const fontStyle = () =>
  `<style>@font-face{font-family:"Receipt Mono";font-weight:400;src:url(${FONTS.regular}) format("woff2")}@font-face{font-family:"Receipt Mono";font-weight:500;src:url(${FONTS.medium}) format("woff2")}</style>`;

/**
 * A drawn slip as an image at `size`, in slip units: the slip alone (tall), or scaled to fit a
 * 4:5 post or a 9:16 story, centred on the theme's page colour with one soft shadow under it.
 */
export function frame(
  drawn: { body: string; height: number },
  o: ReceiptOptions,
  size: ReceiptSize,
): { svg: string; width: number; height: number } {
  const c = INKS[o.paper];
  const { body, height } = drawn;
  const slip = `<path d="${outline(height)}" fill="${c.bg}"/>${body}`;
  // Exact glyph advances at any scale (no rounding to whole pixels), so lines measured at 0.6 em
  // a character meet their leaders and right edges as laid out.
  const head = `<svg xmlns="http://www.w3.org/2000/svg" font-family='${MONO}' text-rendering="geometricPrecision"`;
  if (size === 'tall') {
    return {
      svg: `${head} width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">${fontStyle()}${slip}</svg>`,
      width: WIDTH,
      height,
    };
  }
  const box = SIZES[size];
  const fh = box.h as number;
  const margin = fh * 0.06;
  const scale = Math.min((WIDTH - margin * 2) / WIDTH, (fh - margin * 2) / height);
  const x = (WIDTH - WIDTH * scale) / 2;
  const top = (fh - height * scale) / 2;
  const shadow = o.paper === 'paper' ? 0.18 : 0.55;
  return {
    svg: `${head} width="${WIDTH}" height="${fh}" viewBox="0 0 ${WIDTH} ${fh}">${fontStyle()}<defs><filter id="shadow" x="-20%" y="-10%" width="140%" height="120%"><feDropShadow dx="0" dy="${num(4 / scale)}" stdDeviation="${num(6 / scale)}" flood-color="#000" flood-opacity="${shadow}"/></filter></defs><rect width="${WIDTH}" height="${fh}" fill="${c.page}"/><g transform="translate(${num(x)} ${num(top)}) scale(${num(scale)})"><g filter="url(#shadow)"><path d="${outline(height)}" fill="${c.bg}"/></g>${body}</g></svg>`,
    width: WIDTH,
    height: fh,
  };
}
