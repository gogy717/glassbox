import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type ToolCall } from '../../../../src/core/model.js';
import { totalTokens } from '../../../../src/core/usage.js';
import type { OpenSession } from '../../data/store';
import { summarize } from '../../lib/agents';
import { type Segment, timeBreakdown } from '../../lib/time-stats';
import { rollupByAgent } from '../../lib/token-stats';
import { DEMO_NOW, demoOpen } from '../../test/demo';
import { BAR_HEIGHT, barcode } from './barcode';
import { type ReceiptData, receiptData } from './data';
import { fileName } from './exportImage';
import { durationParts, modelName, partsText, serial } from './format';
import { RECEIPT_STRINGS } from './strings';
import { receiptSvg, SCALE, SIZES, textWidth, WIDTH, wrap } from './svg';
import { COLUMNS, cols, receiptText } from './text';

const NOW = DEMO_NOW.getTime();
const EN = { paper: 'paper', locale: 'en', hideNames: false } as const;
const KEY = 'ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3h';

function demo(change: (o: OpenSession) => OpenSession = (o) => o) {
  const open = change(demoOpen());
  return { open, data: receiptData(open, NOW) };
}
const withSession = (o: OpenSession, s: Partial<OpenSession['session']>): OpenSession => ({
  ...o,
  session: { ...o.session, ...s },
});
/** The text of an SVG: each text element's runs joined, the elements apart. */
const svgText = (svg: string) =>
  [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)]
    .map((t) =>
      [...(t[1] ?? '').matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]).join(''),
    )
    .join(' ');

describe('receipt data: the app’s own figures (R3)', () => {
  it('takes every count, time and token figure from the function behind the app’s', () => {
    const { open, data } = demo();
    const s = summarize(open, MAIN_AGENT_ID, NOW);
    const b = timeBreakdown(open, MAIN_AGENT_ID, NOW);
    const root = rollupByAgent(open)[0];
    if (root?.kind !== 'agent') throw new Error('fixture');
    expect(data.work).toMatchObject({
      requests: s.requests,
      toolCalls: s.toolCalls,
      turns: s.turns,
      subAgents: open.agents.size - 1,
    });
    expect(data.durationMs).toBe(s.activeMs);
    expect(data.time).toMatchObject({
      thinking: b.model.thinking,
      generating: b.model.generating,
      queued: b.model.waiting,
      approval: b.approval,
    });
    expect(data.time.tools).toBe(Object.values(b.tools).reduce((a, x) => a + (x ?? 0), 0));
    expect(data.tokens).toMatchObject({
      measured: s.measured,
      cacheRead: root.total.cacheRead,
      output: root.total.output,
      cacheHit: s.cacheHitRate,
      total: totalTokens(root.total),
    });
    // The categories add up to the tool calls: the biggest three, then the rest.
    expect(data.work.categories.reduce((n, c) => n + c.count, 0)).toBe(s.toolCalls);
    expect(data.work.categories.length).toBeLessThanOrEqual(4);
  });

  it('masks a key pasted into the title, in the image and the text (R4)', () => {
    const { data } = demo((o) => withSession(o, { title: `fix auth, token ${KEY} expired` }));
    expect(data.title).not.toContain(KEY);
    expect(data.title).toContain('•••');
    for (const size of ['tall', 'post', 'story'] as const)
      expect(receiptSvg(data, EN, size).svg).not.toContain(KEY.slice(4, 20));
    expect(receiptText(data, EN)).not.toContain(KEY.slice(4, 20));
  });
});

describe('the receipt', () => {
  it('prints the README’s command at its foot, never npm’s other glassbox (R2)', () => {
    const { data } = demo();
    for (const o of [EN, { ...EN, locale: 'zh' as const }]) {
      for (const out of [svgText(receiptSvg(data, o, 'post').svg), receiptText(data, o)]) {
        expect(out).toContain('npx github:gogy717/glassbox');
        expect(out).not.toMatch(/npx glassbox/);
      }
    }
  });

  it('leaves out a line at zero, and says tokens were not reported rather than print 0', () => {
    const { data } = demo();
    const quiet: ReceiptData = {
      ...data,
      work: { ...data.work, failures: 0, compactions: 0, subAgents: 0 },
      tokens: { ...data.tokens, measured: false },
    };
    const text = receiptText(quiet, EN);
    const image = svgText(receiptSvg(quiet, EN, 'tall').svg);
    for (const out of [text, image]) {
      expect(out).not.toMatch(/Failure|Compaction|Sub-agent|TOTAL|Cache read/);
      expect(out).toContain('Tokens not reported');
    }
    // A failure is the one colour on the slip.
    expect(receiptSvg(data, EN, 'tall').svg).toContain('#b21e25');
    expect(receiptSvg(quiet, EN, 'tall').svg).not.toContain('#b21e25');
  });

  it('withholds the title and the project when names are hidden, and shows no path', () => {
    const { data } = demo();
    const o = { ...EN, hideNames: true };
    for (const out of [svgText(receiptSvg(data, o, 'post').svg), receiptText(data, o)]) {
      expect(out).toContain('Untitled session');
      expect(out).not.toContain(data.title as string);
      expect(out).not.toContain(`${data.project} /`);
    }
    expect(fileName(data, true)).toMatch(/^glassbox-receipt-\d{8}-\d{4}\.png$/);
    expect(fileName(data, false)).toBe(
      `glassbox-receipt-glassbox-${fileName(data, true).slice(17)}`,
    );
    // Never a path, a home or a host: the demo's cwd is not on it.
    const cwd = demoOpen().session.cwd as string;
    expect(receiptSvg(data, EN, 'tall').svg).not.toContain(cwd);
    expect(receiptText(data, EN)).not.toContain(cwd);
  });

  it('is 360 units wide, made 1080 wide at 3×: tall, post 4:5, story 9:16 (R6)', () => {
    const { data } = demo();
    expect(SCALE).toBe(3);
    expect(receiptSvg(data, EN, 'post')).toMatchObject({ width: 360, height: 450 });
    expect(receiptSvg(data, EN, 'story')).toMatchObject({ width: 360, height: 640 });
    const tall = receiptSvg(data, EN, 'tall');
    expect(tall.width * SCALE).toBe(1080);
    expect(tall.height).toBeGreaterThan(450);
    expect(SIZES.post.h).toBe(450);
    // Plex Mono travels inside the image: nothing to fetch when it is drawn.
    expect(tall.svg).toMatch(
      /@font-face\{font-family:"Receipt Mono";font-weight:400;src:url\(data:font\/woff2;base64,/,
    );
    expect(tall.svg).not.toMatch(/url\((?!data:)/);
  });

  it('sets CJK in the UI face and figures in mono, in Chinese', () => {
    const { data } = demo();
    const svg = receiptSvg(data, { ...EN, locale: 'zh' }, 'tall').svg;
    for (const m of svg.matchAll(/<tspan font-family='([^']*)'>([^<]*)<\/tspan>/g)) {
      const [, family = '', body = ''] = m;
      if (/[\u3000-\u9fff]/.test(body)) expect(family).not.toContain('Receipt Mono');
      if (/^[\d.,]+$/.test(body)) expect(family).toContain('Receipt Mono');
    }
    expect(svgText(svg)).toContain('模型调用');
    expect(svgText(svg)).toContain('每一个 token 都有去处。');
  });

  it('says a running session runs on, up to now', () => {
    const { data } = demo();
    const running = { ...data, running: true };
    const text = receiptText(running, EN);
    expect(text).toMatch(/\d\d:\d\d → now/);
    // On the date line when it fits the block, else beside the duration.
    expect(text).toMatch(/→ now · still running|DURATION · still running/);
    expect(svgText(receiptSvg(running, EN, 'tall').svg)).toContain('still running');
  });
});

describe('the text version (R7)', () => {
  it('stays within 40 lines and 44 columns, every line aligned, in English and Chinese', () => {
    const { data } = demo();
    const full: ReceiptData = {
      ...data,
      title:
        'A very long title that needs every one of its three lines to fit, and then some more words beyond that',
      work: { ...data.work, failures: 2, compactions: 3, subAgents: 4 },
      time: { ...data.time, approval: 40 * 60_000, queued: 90_000, longestThink: 252_000 },
    };
    for (const locale of ['en', 'zh'] as const) {
      const lines = receiptText(full, { ...EN, locale }).split('\n');
      expect(lines.length).toBeLessThanOrEqual(40);
      expect(lines[0]).toBe('```');
      expect(lines.at(-1)).toBe('```');
      expect(lines.filter((l) => cols(l) > COLUMNS)).toEqual([]);
    }
    const en = receiptText(full, EN).split('\n');
    // Figures end in one column: the TIME values before their shares, tokens at the margin.
    expect(
      new Set(en.filter((l) => / \d+%$/.test(l) && l.includes('..')).map((l) => cols(l))),
    ).toEqual(new Set([COLUMNS]));
  });
});

describe('the barcode', () => {
  const seg = (kind: Segment['kind'], start: number, end: number, refId = 'x'): Segment => ({
    kind,
    start,
    end,
    refId,
    requestId: 'r',
  });

  it('gives each column the kind that filled most of it, and merges runs into bars', () => {
    const code = barcode(
      [seg('thinking', 0, 50), seg('generating', 50, 75), seg('tool', 75, 100, 'ok')],
      [],
      new Set(),
      100,
    );
    expect(code.bars).toEqual([
      { x: 0, w: 50, kind: 'thinking' },
      { x: 50, w: 25, kind: 'generating' },
      { x: 75, w: 25, kind: 'tool' },
    ]);
    expect(BAR_HEIGHT).toMatchObject({ thinking: 42, generating: 29, tool: 16, approval: 3 });
  });

  it('draws a failed tool in failure red, and no bar for queued time', () => {
    const code = barcode(
      [seg('waiting', 0, 50), seg('tool', 50, 100, 'bad')],
      [],
      new Set(['bad']),
      100,
    );
    expect(code.bars).toEqual([{ x: 50, w: 50, kind: 'fail' }]);
  });

  it('squeezes an idle gap to 2% of the width and marks it, so days apart still fit', () => {
    const day = 86_400_000;
    const code = barcode(
      [seg('thinking', 0, 60_000), seg('thinking', 3 * day, 3 * day + 60_000)],
      [],
      new Set(),
      316,
    );
    expect(code.breaks).toHaveLength(1);
    const widths = code.bars.map((b) => b.w);
    expect(widths.reduce((a, b) => a + b, 0)).toBeGreaterThan(300);
    expect(code.bars.length).toBe(2);
  });

  it('draws at most six sub-agent tracks, the rest merged into the last', () => {
    const subs = Array.from({ length: 9 }, (_, i) => [i * 10, i * 10 + 5] as [number, number]);
    const code = barcode([seg('thinking', 0, 100)], subs, new Set(), 316);
    expect(code.tracks).toHaveLength(6);
    expect(code.more).toBe(4);
    expect(code.bars.length).toBeLessThanOrEqual(316);
  });

  it('draws a 5,000-tool session in under 300 ms (R1.3 performance)', () => {
    const open = demoOpen();
    const tools = new Map(open.toolCalls);
    const base = [...open.toolCalls.values()][0] as ToolCall;
    const t0 = Date.parse(base.startedAt as string);
    for (let i = 0; i < 5000; i++) {
      const at = t0 + i * 1500;
      tools.set(`t${i}`, {
        ...base,
        id: `t${i}`,
        startedAt: new Date(at).toISOString(),
        endedAt: new Date(at + 900).toISOString(),
        durationMs: 900,
        status: i % 97 === 0 ? 'error' : 'complete',
      });
    }
    const big = { ...open, toolCalls: tools };
    const start = performance.now();
    const data = receiptData(big, NOW);
    receiptSvg(data, EN, 'post');
    receiptText(data, EN);
    expect(performance.now() - start).toBeLessThan(300);
    expect(data.work.toolCalls).toBe(tools.size);
  });
});

describe('receipt wording', () => {
  it('words durations as a slip prints them', () => {
    expect(partsText(durationParts(4 * 3600_000 + 12 * 60_000, 'en'))).toBe('4h 12m');
    expect(partsText(durationParts(3600_000 + 2 * 60_000, 'en'))).toBe('1h 02m');
    expect(partsText(durationParts(38 * 60_000, 'en'))).toBe('38m');
    expect(partsText(durationParts(4 * 60_000 + 12_000, 'en'))).toBe('4m 12s');
    expect(partsText(durationParts(4 * 3600_000 + 12 * 60_000, 'zh'))).toBe('4 小时 12 分');
  });

  it('names Claude models plainly, and others as they are', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    expect(modelName('gpt-5.1-codex')).toBe('gpt-5.1-codex');
  });

  it('prints a serial of four id characters, the date and the hours', () => {
    const start = new Date(2026, 9, 24, 9, 14).getTime();
    const end = new Date(2026, 9, 24, 13, 26).getTime();
    expect(serial('a3f9c1d2-xxxx', start, end)).toBe('a3f9 · 2026 1024 · 0914 1326');
  });

  it('wraps a long title in at most three lines, ending in an ellipsis', () => {
    const lines = wrap('word '.repeat(80), 13, 316, 3);
    expect(lines).toHaveLength(3);
    expect(lines[2]?.endsWith('…')).toBe(true);
    for (const l of lines) expect(textWidth(l, 13)).toBeLessThanOrEqual(316);
    expect(WIDTH).toBe(360);
  });

  it('has every word in both languages', () => {
    expect(Object.keys(RECEIPT_STRINGS.zh).sort()).toEqual(Object.keys(RECEIPT_STRINGS.en).sort());
  });
});
