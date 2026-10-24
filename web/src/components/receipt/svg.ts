/**
 * The receipt as one SVG, drawn the same for the preview and for export: a 360-unit-wide slip
 * with toothed edges, in ink on paper (or the reverse at night), failure red its only colour.
 * Latin and figures are set in IBM Plex Mono (embedded, so the image needs nothing from the
 * network); CJK words in the system's UI face, never in mono.
 */
import { type Locale, type MessageKey, translate } from '../../i18n';
import { agentName } from '../../lib/agent-names';
import { formatCompact } from '../../lib/format';
import { BAR_HEIGHT, type BarKind, barcode } from './barcode';
import type { ReceiptData } from './data';
import { FONTS } from './fonts';
import { clock, day, durationParts, modelName, type Parts, percent, serial } from './format';
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
const LEFT = 22;
const RIGHT = WIDTH - LEFT;
const INNER = RIGHT - LEFT;
const TOOTH = 6;
const TEETH = 5;

/** Output sizes in slip units; exported at 3× (1080 wide). */
export const SIZES: Record<ReceiptSize, { w: number; h: number | null }> = {
  tall: { w: WIDTH, h: null },
  post: { w: WIDTH, h: 450 },
  story: { w: WIDTH, h: 640 },
};
export const SCALE = 3;

const INKS: Record<
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

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;
const CJK_RUNS = /([⺀-鿿豈-﫿＀-￯　-〿]+)/;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
const num = (n: number) => String(Math.round(n * 100) / 100);

/** Width of `s` at `size`: Plex Mono advances 0.6 em, a CJK character in the UI face about 1 em. */
export function textWidth(s: string, size: number, spacing = 0): number {
  let w = 0;
  for (const ch of s) w += (CJK.test(ch) ? 1 : 0.6) * size + spacing;
  return w;
}

interface TextStyle {
  size?: number;
  weight?: number;
  fill?: string;
  anchor?: 'start' | 'middle' | 'end';
  /** Letter spacing in units. */
  spacing?: number;
}

/** `s` split into runs: CJK in the UI face, everything else in mono. */
const runs = (s: string) =>
  s
    .split(CJK_RUNS)
    .filter(Boolean)
    .map((part) => `<tspan font-family='${CJK.test(part) ? UI : MONO}'>${esc(part)}</tspan>`)
    .join('');

function text(x: number, y: number, body: string, st: TextStyle = {}): string {
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
const partsBody = (p: Parts) => p.map((x) => runs(x.digits) + runs(x.unit)).join('');
const partsWidth = (p: Parts, size: number) =>
  p.reduce((w, x) => w + textWidth(x.digits, size) + textWidth(x.unit, size), 0);

/**
 * Lines of at most `width`, broken between words (between characters for CJK, or inside a word
 * too long for a line); past `max` lines the last one ends in "…".
 */
export function wrap(s: string, size: number, width: number, max: number): string[] {
  const tokens = s.match(/[⺀-鿿豈-﫿＀-￯　-〿]|[^\s⺀-鿿豈-﫿＀-￯　-〿]+|\s+/g) ?? [];
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

/** The receipt's drawing (without its outline) and its height, in slip units. */
export function drawReceipt(d: ReceiptData, o: ReceiptOptions): { body: string; height: number } {
  const c = INKS[o.paper];
  const L = o.locale;
  const w = (key: ReceiptKey, params?: Record<string, string | number>) => rt(L, key, params);
  const out: string[] = [];
  let y = 0;
  const rule = (dashed = true) => {
    out.push(
      `<line x1="${LEFT}" y1="${num(y)}" x2="${RIGHT}" y2="${num(y)}" stroke="${dashed ? c.soft : c.ink}" stroke-width="1"${dashed ? ' stroke-dasharray="3 3"' : ''}/>`,
    );
  };
  // Section labels: small caps of a printed form; Chinese has no case and no tracking.
  const label = (key: ReceiptKey, at = LEFT, anchor: TextStyle['anchor'] = 'start') =>
    out.push(
      text(at, y, runs(L === 'zh' ? w(key) : w(key).toUpperCase()), {
        size: 10,
        fill: c.soft,
        anchor,
        spacing: L === 'zh' ? 0 : 1.4,
      }),
    );
  const leader = (x0: number, x1: number) => {
    if (x1 - x0 > 8)
      out.push(
        `<line x1="${num(x0)}" y1="${num(y - 3)}" x2="${num(x1)}" y2="${num(y - 3)}" stroke="${c.faint}" stroke-width="1" stroke-dasharray="1 2.5"/>`,
      );
  };
  /** label ........ value  [share]: the value right at `valueRight`, the share at the margin. */
  const row = (
    name: string,
    value: Parts,
    st: { size?: number; fill?: string; share?: string; valueRight?: number; indent?: number } = {},
  ) => {
    const size = st.size ?? 12;
    const x = LEFT + (st.indent ?? 0);
    const right = st.valueRight ?? RIGHT;
    out.push(text(x, y, runs(name), { size, fill: st.fill ?? c.ink }));
    out.push(text(right, y, partsBody(value), { size, fill: st.fill ?? c.ink, anchor: 'end' }));
    if (st.share) out.push(text(RIGHT, y, runs(st.share), { size, fill: c.soft, anchor: 'end' }));
    leader(x + textWidth(name, size) + 6, right - partsWidth(value, size) - 6);
  };
  const figure = (s: string): Parts => [{ digits: s, unit: '' }];
  const compact = (n: number) => formatCompact(n, L);

  // Head: the mark and name, RECEIPT at the right, a rule.
  y = 39;
  out.push(mark(LEFT, y - 11, c.ink));
  out.push(text(LEFT + 18, y, runs('glassbox'), { size: 15, weight: 500, fill: c.ink }));
  label('heading', RIGHT, 'end');
  y = 60;
  rule(false);
  // Who, when.
  y = 78;
  const who = [
    agentName(d.agent),
    d.model ? modelName(d.model) : null,
    d.effort ? w('effort', { e: d.effort }) : null,
  ];
  out.push(text(LEFT, y, runs(who.filter(Boolean).join(' · ')), { size: 11, fill: c.soft }));
  y += 17;
  const span = d.running
    ? `${d.start !== null ? clock(d.start) : ''} → ${w('now')} · ${w('stillRunning')}`
    : d.start !== null
      ? `${clock(d.start)} – ${clock(d.end)}`
      : clock(d.end);
  out.push(
    text(LEFT, y, runs(`${day(d.start ?? d.end, L)} · ${span.trim()}`), { size: 11, fill: c.soft }),
  );
  // The hero: how long it worked.
  y += 37;
  label('duration');
  out.push(
    text(
      RIGHT,
      y + 5,
      d.durationMs === null ? runs('—') : partsBody(durationParts(d.durationMs, L)),
      {
        size: 24,
        weight: 500,
        fill: c.ink,
        anchor: 'end',
      },
    ),
  );
  y += 20;
  rule();
  // What it was about, unless the names are withheld.
  y += 18;
  if (!o.hideNames && d.project) {
    out.push(text(LEFT, y, runs(`${d.project} /`), { size: 11, fill: c.soft }));
    y += 20;
  }
  const title = o.hideNames || !d.title ? w('untitled') : d.title;
  for (const line of wrap(title, 13, INNER, 3)) {
    out.push(text(LEFT, y, runs(line), { size: 13, weight: 600, fill: c.ink }));
    y += 19.5;
  }
  y += 3;
  rule();

  // WORK: counts; a line at zero is left out.
  y += 18;
  label('work');
  const counts: [number, ReceiptKey, boolean?][] = [
    [d.work.requests, 'modelCalls'],
    [d.work.toolCalls, 'toolCalls'],
  ];
  const workRow = (n: number, key: ReceiptKey, fail = false) => {
    y += 19;
    const fill = fail ? c.fail : c.ink;
    out.push(text(LEFT + 30, y, runs(String(n)), { fill, anchor: 'end' }));
    out.push(text(LEFT + 38, y, runs(w(key, { n })), { fill }));
  };
  for (const [n, key] of counts) {
    if (n <= 0) continue;
    workRow(n, key);
    if (key === 'toolCalls' && d.work.categories.length > 0) {
      y += 17;
      const cats = d.work.categories
        .map(({ category, count }) => {
          const name = translate(L, `steps.cat.${category}` as MessageKey);
          return `${L === 'en' ? name.toLowerCase() : name} ${count}`;
        })
        .join(' · ');
      out.push(text(LEFT + 38, y, runs(cats), { size: 11, fill: c.soft }));
    }
  }
  if (d.work.subAgents > 0) workRow(d.work.subAgents, 'subAgents');
  if (d.work.turns > 0) workRow(d.work.turns, 'conversations');
  if (d.work.failures > 0) workRow(d.work.failures, 'failures', true);
  if (d.work.compactions > 0) workRow(d.work.compactions, 'compactions');
  y += 22;
  rule();

  // TIME: where it went, each line's share of what is printed.
  y += 18;
  label('time');
  const parts: [ReceiptKey, number][] = (
    [
      ['thinking', d.time.thinking],
      ['generating', d.time.generating],
      ['tools', d.time.tools],
      ['approval', d.time.approval],
      ['queued', d.time.queued],
    ] as [ReceiptKey, number][]
  ).filter(([, v]) => v >= 1000);
  const whole = parts.reduce((s, [, v]) => s + v, 0);
  for (const [key, v] of parts) {
    y += 19;
    row(w(key), durationParts(v, L), { valueRight: RIGHT - 42, share: percent(v / whole) });
  }
  if (d.time.longestThink >= 1000) {
    y += 17;
    row(w('longestThink'), durationParts(d.time.longestThink, L), {
      size: 11,
      fill: c.soft,
      valueRight: RIGHT - 42,
    });
  }

  // The barcode: the session's own timeline.
  const code = barcode(d.segments, d.subAgents, d.failedTools, INNER);
  if (code.bars.length > 0 || code.tracks.length > 0) {
    const bottom = y + 12 + 42;
    const ink = (k: BarKind) => (k === 'fail' ? c.fail : k === 'approval' ? c.soft : c.ink);
    for (const b of code.bars) {
      const h = BAR_HEIGHT[b.kind];
      out.push(
        `<rect x="${num(LEFT + b.x)}" y="${num(bottom - h)}" width="${num(b.w)}" height="${h}" fill="${ink(b.kind)}"/>`,
      );
    }
    for (const x of code.breaks)
      out.push(
        `<path d="M${num(LEFT + x - 3)} ${num(bottom + 3)} l2 -6 M${num(LEFT + x + 1)} ${num(bottom + 3)} l2 -6" stroke="${c.soft}" stroke-width="1"/>`,
      );
    let ty = bottom + 6;
    code.tracks.forEach((t, i) => {
      out.push(
        `<rect x="${num(LEFT + t.x)}" y="${num(ty)}" width="${num(t.w)}" height="2" fill="${c.soft}"/>`,
      );
      if (i === code.tracks.length - 1 && code.more > 0)
        out.push(
          text(RIGHT, ty + 2.5, runs(`+${code.more}`), { size: 8, fill: c.soft, anchor: 'end' }),
        );
      ty += 4;
    });
    y = ty + 14;
    out.push(
      text(LEFT, y, runs(d.start !== null ? clock(d.start) : ''), { size: 10.5, fill: c.soft }),
    );
    out.push(
      text(RIGHT, y, runs(d.running ? w('now') : clock(d.end)), {
        size: 10.5,
        fill: c.soft,
        anchor: 'end',
      }),
    );
    y += 17;
    out.push(
      text(WIDTH / 2, y, runs(serial(d.nativeId, d.start, d.end)), {
        size: 10.5,
        fill: c.soft,
        anchor: 'middle',
        spacing: 1,
      }),
    );
  }
  y += 18;
  rule();

  // TOKENS: what the session read and wrote, unless no call reported usage.
  y += 18;
  label('tokens');
  const t = d.tokens;
  if (!t.measured) {
    y += 20;
    out.push(text(LEFT, y, runs(w('notReported')), { fill: c.soft }));
  } else {
    y += 12;
    const shares = [t.cacheRead, t.cacheWrite, t.uncached, t.output];
    const sum = shares.reduce((a, b) => a + b, 0);
    const opacity = [1, 0.55, 0.35, 0.2];
    let x = LEFT;
    shares.forEach((v, i) => {
      const bw = sum > 0 ? (v / sum) * INNER : 0;
      if (bw > 0)
        out.push(
          `<rect x="${num(x)}" y="${num(y)}" width="${num(bw)}" height="3.5" fill="${c.ink}" fill-opacity="${opacity[i]}"/>`,
        );
      x += bw;
    });
    y += 4;
    const tokenRow = (key: ReceiptKey, v: number) => {
      if (v <= 0) return;
      y += 19;
      row(w(key), figure(compact(v)));
    };
    tokenRow('cacheRead', t.cacheRead);
    tokenRow('cacheWrite', t.cacheWrite);
    tokenRow('uncached', t.uncached);
    tokenRow('output', t.output);
    if (t.thinking > 0) {
      y += 17;
      row(w('ofThinking'), figure(compact(t.thinking)), { size: 11, fill: c.soft, indent: 14 });
    }
    if (t.cacheHit !== null) {
      y += 19;
      row(w('cacheHit'), figure(percent(t.cacheHit)));
    }
    y += 14;
    rule(false);
    y += 26;
    label('total');
    out.push(
      text(RIGHT, y + 4, runs(compact(t.total)), {
        size: 24,
        weight: 500,
        fill: c.ink,
        anchor: 'end',
      }),
    );
  }

  // The foot: who printed it, and how to print yours.
  y += 38;
  out.push(
    text(WIDTH / 2, y, runs(w('printedBy')), {
      size: 11,
      fill: c.soft,
      anchor: 'middle',
      spacing: 0.6,
    }),
  );
  y += 18;
  out.push(
    text(WIDTH / 2, y, runs('npx github:gogy717/glassbox'), {
      size: 11.5,
      fill: c.ink,
      anchor: 'middle',
    }),
  );
  y += 18;
  out.push(
    text(WIDTH / 2, y, runs(w('motto')), {
      size: 11,
      fill: c.soft,
      anchor: 'middle',
      spacing: 0.6,
    }),
  );
  return { body: out.join(''), height: Math.ceil(y + 30) };
}

const fontStyle = () =>
  `<style>@font-face{font-family:"Receipt Mono";font-weight:400;src:url(${FONTS.regular}) format("woff2")}@font-face{font-family:"Receipt Mono";font-weight:500;src:url(${FONTS.medium}) format("woff2")}</style>`;

/**
 * The image at `size`, in slip units: the slip alone (tall), or scaled to fit a 4:5 post or a
 * 9:16 story, centred on the theme's page colour with one soft shadow under it.
 */
export function receiptSvg(
  d: ReceiptData,
  o: ReceiptOptions,
  size: ReceiptSize,
): { svg: string; width: number; height: number } {
  const c = INKS[o.paper];
  const { body, height } = drawReceipt(d, o);
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
  const frame = SIZES[size];
  const fh = frame.h as number;
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
