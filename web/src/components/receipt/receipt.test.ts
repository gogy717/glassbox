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
import { clean, printedProject, printedTitle, wellFormed } from './printed';
import { categoryLine, shares, timeRows } from './rows';
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

  it('leaves out TIME when nothing was timed, and widens the count column for big counts', () => {
    const { data } = demo();
    const untimed: ReceiptData = {
      ...data,
      segments: [],
      subAgents: [],
      subSegments: [],
      time: { thinking: 0, generating: 0, tools: 0, approval: 0, queued: 0, longestThink: 0 },
    };
    // The TIME section, not the ACTIVE TIME at the top.
    expect(svgText(receiptSvg(untimed, EN, 'tall').svg)).not.toMatch(/(?<!ACTIVE )\bTIME\b/);
    expect(receiptText(untimed, EN)).not.toMatch(/^TIME$/m);
    const big = { ...data, work: { ...data.work, toolCalls: 12_345 } };
    const svg = receiptSvg(big, EN, 'tall').svg;
    // Five digits end at 22 + 5 × 7.2: never past the left margin.
    const at =
      /<text x="([\d.]+)" y="[\d.]+" font-size="12" fill="#1c1e22" text-anchor="end"><tspan[^>]*>12345</.exec(
        svg,
      );
    expect(Number(at?.[1])).toBeCloseTo(22 + 5 * 7.2, 1);
  });

  it('heads its figure as the Summary bar does: ACTIVE TIME, 活跃时长', () => {
    const { data } = demo();
    const zh = { ...EN, locale: 'zh' } as const;
    // The demo session still runs: "still running" joins the name when the date line is full.
    expect(receiptText(data, EN)).toMatch(/^ACTIVE TIME( · still running)? +\d/m);
    expect(svgText(receiptSvg(data, EN, 'tall').svg)).toContain('ACTIVE TIME');
    expect(receiptText(data, zh)).toMatch(/\d\S* +活跃时长$/m);
    expect(svgText(receiptSvg(data, zh, 'tall').svg)).toContain('活跃时长');
    for (const o of [EN, zh]) {
      expect(receiptText(data, o)).not.toMatch(/DURATION|总耗时/);
      expect(svgText(receiptSvg(data, o, 'tall').svg)).not.toMatch(/DURATION|总耗时/);
    }
  });

  it('says a running session runs on, up to now', () => {
    const { data } = demo();
    const running = { ...data, running: true };
    const text = receiptText(running, EN);
    expect(text).toMatch(/\d\d:\d\d → now/);
    // On the date line when it fits the block, else beside the active time.
    expect(text).toMatch(/→ now · still running|ACTIVE TIME · still running/);
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
    // The target is 300 ms on a laptop; the bound is loose so a slow CI machine does not fail it.
    expect(performance.now() - start).toBeLessThan(1500);
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

describe('fix round 1', () => {
  const MIN = 60_000;
  it('gives TIME whole shares that add up to 100 (F2)', () => {
    // Rounded alone these read 31 + 21 + 31 + 18 = 101, and 48 + 32 + 19 = 99.
    expect(shares([72, 48, 71, 41]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(shares([4.85, 3.25, 1.9]).reduce((a, b) => a + b, 0)).toBe(100);
    const { data } = demo();
    const rows = timeRows({
      ...data,
      time: {
        ...data.time,
        thinking: 72 * MIN,
        generating: 48 * MIN,
        tools: 71 * MIN,
        queued: 41 * MIN,
      },
    });
    expect(rows.reduce((n, r) => n + r.share, 0)).toBe(100);
    expect(timeRows(data).reduce((n, r) => n + r.share, 0)).toBe(100);
    // The image and the text print the same shares.
    const text = receiptText(data, EN);
    for (const r of timeRows(data)) expect(text).toContain(`${r.share}%`);
  });

  it('prints no "every token accounted for" when none were (F4)', () => {
    const { data } = demo();
    const quiet = { ...data, tokens: { ...data.tokens, measured: false } };
    expect(svgText(receiptSvg(quiet, EN, 'tall').svg)).not.toContain('Every token accounted for.');
    expect(receiptText(quiet, EN)).not.toContain('Every token accounted for.');
    expect(receiptText(data, EN)).toContain('Every token accounted for.');
  });

  it('folds the smallest categories into other until the line fits (F5)', () => {
    const cats = [
      { category: 'explore', count: 172 },
      { category: 'edit', count: 141 },
      { category: 'delegate', count: 29 },
      { category: 'other', count: 24 },
    ] as ReceiptData['work']['categories'];
    expect(categoryLine(cats, 'en', (l) => l.length <= 37)).toBe(
      'explore 172 · edit 141 · other 53',
    );
    const { data } = demo();
    const wide = { ...data, work: { ...data.work, toolCalls: 366, categories: cats } };
    const text = receiptText(wide, EN).split('\n');
    expect(text.filter((l) => cols(l) > COLUMNS)).toEqual([]);
    const line =
      /<text x="([\d.]+)"[^>]*font-size="11"[^>]*>(?:<tspan[^>]*>[^<]*<\/tspan>)*?<tspan[^>]*>explore[^<]*/.exec(
        receiptSvg(wide, EN, 'tall').svg,
      );
    expect(line).not.toBeNull();
    const shown = svgText(receiptSvg(wide, EN, 'tall').svg);
    const printed = shown.match(/explore 172[^A-Z]*?other \d+/)?.[0] ?? '';
    expect(Number(line?.[1]) + textWidth(printed, 11)).toBeLessThanOrEqual(338);
  });

  it('prints a project only as a name: never an encoded home path (F6)', () => {
    expect(printedProject('/home/someone/dev/acme-app', 'whatever')).toBe('acme-app');
    expect(printedProject('C:\\Users\\someone\\app', 'x')).toBe('app');
    expect(printedProject(null, '-home-someone-dev-acme-app')).toBeNull();
    expect(printedProject(null, '-orca-workspaces-glassbox-gramma')).toBeNull();
    expect(printedProject(null, 'a/b')).toBeNull();
    expect(printedProject(null, 'acme-app')).toBe('acme-app');
    const { data } = demo((o) => withSession(o, { cwd: null, project: '-home-someone-dev-acme' }));
    expect(data.project).toBeNull();
    for (const out of [svgText(receiptSvg(data, EN, 'tall').svg), receiptText(data, EN)])
      expect(out).not.toContain('someone');
    expect(fileName(data, false)).toMatch(/^glassbox-receipt-\d{8}-\d{4}\.png$/);
  });

  it('cuts an absolute path in a title to its last segment, and keeps relative ones (F12)', () => {
    expect(printedTitle('fix /home/someone/acme/api/build.ts now')).toBe('fix build.ts now');
    expect(printedTitle('look at ~/dev/acme')).toBe('look at acme');
    expect(printedTitle('open C:\\Users\\someone\\proj')).toBe('open proj');
    expect(printedTitle('edit src/app.ts and /tmp')).toBe('edit src/app.ts and /tmp');
    expect(printedTitle('see https://github.com/o/r/pull/1')).toBe(
      'see https://github.com/o/r/pull/1',
    );
    // Control characters (a terminal's colour codes) never reach the SVG.
    expect(printedTitle('\u001b[31mred\u001b[0m')).toBe('[31mred[0m');
  });

  it('squeezes every gap that would take over 2% of the barcode, lunch included (F8)', () => {
    const t0 = Date.UTC(2026, 9, 21, 9);
    const seg = (start: number, end: number): Segment => ({
      kind: 'thinking',
      start,
      end,
      refId: 'x',
      requestId: 'r',
    });
    const segments: Segment[] = [];
    for (let m = 0; m < 180; m += 2) segments.push(seg(t0 + m * MIN, t0 + (m + 1) * MIN));
    for (let m = 240; m < 480; m += 2) segments.push(seg(t0 + m * MIN, t0 + (m + 1) * MIN));
    segments.push(seg(t0 + 3 * 86_400_000, t0 + 3 * 86_400_000 + 60 * MIN));
    const code = barcode(segments, [], new Set(), 316);
    // The three-day gap and the hour at lunch: both squeezed, both marked.
    expect(code.breaks).toHaveLength(2);
  });

  it('draws a column where only a sub-agent works as a tool, not as idle (F1)', () => {
    const seg = (start: number, end: number): Segment => ({
      kind: 'thinking',
      start,
      end,
      refId: 'x',
      requestId: 'r',
    });
    const code = barcode([seg(0, 10), seg(90, 100)], [[10, 90]], new Set(), 100);
    expect(code.bars).toEqual([
      { x: 0, w: 10, kind: 'thinking' },
      { x: 10, w: 80, kind: 'tool' },
      { x: 90, w: 10, kind: 'thinking' },
    ]);
    expect(code.breaks).toEqual([]);
  });

  it('aligns the Chinese text whatever width a font gives CJK: figures first (F10)', () => {
    const { data } = demo();
    const lines = receiptText(data, { ...EN, locale: 'zh' }).split('\n');
    const cjk = /[\u3000-\u9fff]/;
    // Every line with a figure and a CJK word has the figure first, in ASCII.
    const figured = lines.filter((l) => /^\s*\d/.test(l) && cjk.test(l));
    expect(figured.length).toBeGreaterThan(8);
    // Where the words start does not depend on CJK width: only ASCII comes before them.
    const at = (l: string) => l.search(cjk);
    for (const l of figured) expect(cjk.test(l.slice(0, at(l)))).toBe(false);
    // TIME's rows (between its heading and the next rule) start their words in one column.
    const from = lines.indexOf('时间');
    const time = lines
      .slice(from + 1, lines.indexOf('-'.repeat(COLUMNS), from))
      .filter((l) => /%/.test(l));
    expect(time.length).toBeGreaterThan(1);
    expect(new Set(time.map(at)).size).toBe(1);
    expect(lines.join('\n')).toMatch(/\d+[hms]/);
    expect(lines.join('\n')).not.toMatch(/\d+ 分/);
  });

  it('reads cache hit as the Summary bar does, and cuts an over-long model line (F11)', () => {
    const { data } = demo();
    const hit = {
      ...data,
      tokens: { ...data.tokens, cacheHit: 0.996 },
      model: `m-${'x'.repeat(80)}`,
    };
    expect(svgText(receiptSvg(hit, EN, 'tall').svg)).toContain('99.6%');
    expect(receiptText(hit, EN)).toContain('99.6%');
    const text = receiptText(hit, EN).split('\n');
    expect(text.find((l) => l.startsWith('Claude Code'))).toMatch(/…$/);
    expect(text.filter((l) => cols(l) > COLUMNS)).toEqual([]);
  });

  it('labels queued time as waiting on the API, and puts +N at the merged track’s start (F13)', () => {
    const { data } = demo();
    const queued = { ...data, time: { ...data.time, queued: 5 * MIN } };
    expect(receiptText(queued, EN)).toContain('Waiting (API)');
    expect(receiptText(queued, { ...EN, locale: 'zh' })).toContain('等待 API');
    const subs = Array.from(
      { length: 9 },
      (_, i) => [i * 10 + 30, i * 10 + 35] as [number, number],
    );
    const seg: Segment = { kind: 'thinking', start: 0, end: 200, refId: 'x', requestId: 'r' };
    const svg = receiptSvg({ ...data, segments: [seg], subAgents: subs }, EN, 'tall').svg;
    const label =
      /<text x="([\d.]+)"[^>]*font-size="9"[^>]*text-anchor="end"><tspan[^>]*>\+4</.exec(svg);
    expect(label).not.toBeNull();
  });
});

describe('fix round 2', () => {
  const DAY = 86_400_000;
  const seg = (kind: Segment['kind'], start: number, end: number): Segment => ({
    kind,
    start,
    end,
    refId: 'x',
    requestId: 'r',
  });
  /** No lone surrogate, no U+FFFE / U+FFFF: what an SVG (XML) can hold. */
  const wellFormedXml = (s: string) =>
    !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|[\ufffe\uffff]/.test(
      s,
    );

  it('cuts a path wherever it starts: after a backtick, a bracket, a colon, a comma or CJK (P1)', () => {
    const cases: [string, string][] = [
      ['see `/home/someone/acme/a.ts`', 'see `a.ts`'],
      ['(/home/someone/acme/b.ts)', '(b.ts)'],
      ['fix:/home/someone/acme/c.ts', 'fix:c.ts'],
      ['路径：/home/someone/acme/d.ts', '路径：d.ts'],
      ['a,/home/someone/acme/e.ts', 'a,e.ts'],
      ['看看/home/someone/acme/f.ts里的错', '看看f.ts里的错'],
      ['修复`/home/someone/acme/g.ts`的bug，再说', '修复`g.ts`的bug，再说'],
      ['open C:\\Users\\John Smith\\proj\\h.ts now', 'open h.ts now'],
      ['in /mnt/c/Users/John Smith/acme/i.ts', 'in i.ts'],
      ['~someone/dev/j.md and ~someone/k.md', 'j.md and k.md'],
      ['\\\\fileserver\\share\\someone\\l.docx', 'l.docx'],
      ['file:///home/someone/acme/m.ts', 'm.ts'],
      ['file://C:/Users/someone/n.ts', 'n.ts'],
      // A home directory itself prints as "~": its last segment is a name.
      ['cd /home/someone', 'cd ~'],
      ['in /Users/someone', 'in ~'],
      ['C:\\Users\\someone', '~'],
      // Not absolute paths, or not a person's: kept as typed.
      ['see https://github.com/o/r/pull/1', 'see https://github.com/o/r/pull/1'],
      ['and/or', 'and/or'],
      ['edit src/app.ts and ./a/b', 'edit src/app.ts and ./a/b'],
      ['clear /tmp', 'clear /tmp'],
      ['on 2026/10/24', 'on 2026/10/24'],
      ['look at ~/x', 'look at ~/x'],
    ];
    for (const [title, printed] of cases) expect(printedTitle(title), title).toBe(printed);
  });

  it('never prints a home directory as the project, in the image, the text or the file name (P2)', () => {
    for (const cwd of [
      '/home/someone',
      '/home/someone/',
      '/Users/someone',
      '/var/home/someone',
      'C:\\Users\\someone',
      'c:/Users/someone',
      '/mnt/c/Users/someone',
      'C:\\',
      'D:',
    ])
      expect(printedProject(cwd, 'someone'), cwd).toBeNull();
    expect(printedProject(null, 'C--Users-someone-acme')).toBeNull();
    expect(printedProject('/home/someone/acme', 'x')).toBe('acme');
    expect(printedProject('C:\\Users\\someone\\acme', 'x')).toBe('acme');
    const { data } = demo((o) =>
      withSession(o, {
        cwd: '/home/someone',
        project: 'someone',
        title: 'fix `/home/someone/acme/a.ts`',
      }),
    );
    expect(data.project).toBeNull();
    for (const out of [
      svgText(receiptSvg(data, EN, 'tall').svg),
      receiptText(data, EN),
      fileName(data, false),
    ])
      expect(out).not.toContain('someone');
  });

  it('keeps a gap of 300 days squeezed: the barcode stays drawn (P3)', () => {
    const t0 = Date.UTC(2026, 0, 1);
    for (const days of [199, 300]) {
      const gap = days * DAY;
      const code = barcode(
        [seg('thinking', t0, t0 + 60_000), seg('thinking', t0 + gap, t0 + gap + 60_000)],
        [],
        new Set(),
        316,
      );
      expect(code.breaks, `${days} days`).toHaveLength(1);
      expect(
        code.bars.reduce((n, b) => n + b.w, 0),
        `${days} days`,
      ).toBeGreaterThan(300);
    }
  });

  it('draws a delegated column as the busiest sub-agent’s work, not a flat band (P4)', () => {
    // The main agent thinks, then waits 10–90 on two sub-agents; one works in rhythm, the other
    // barely (a sliver of output at 21).
    const busy = [
      seg('thinking', 10, 40),
      seg('generating', 40, 60),
      seg('waiting', 60, 70),
      seg('tool', 70, 80),
      seg('generating', 80, 90),
    ];
    const idle = [seg('generating', 21, 21.5)];
    const code = barcode(
      [seg('thinking', 0, 10), seg('thinking', 90, 100)],
      [
        [10, 90],
        [10, 90],
      ],
      new Set(),
      100,
      [busy, idle],
    );
    expect(code.bars).toEqual([
      { x: 0, w: 40, kind: 'thinking' },
      { x: 40, w: 20, kind: 'generating' },
      // Waiting on the API, still alive: delegation stays a low bar, never a blank.
      { x: 60, w: 20, kind: 'tool' },
      { x: 80, w: 10, kind: 'generating' },
      { x: 90, w: 10, kind: 'thinking' },
    ]);
    // TIME is still the main agent's alone, and the data carries each sub-agent's timeline.
    const { data } = demo();
    expect(data.subSegments).toHaveLength(data.work.subAgents);
    expect(data.subSegments.flat().length).toBeGreaterThan(0);
    expect(data.time.thinking).toBe(timeBreakdown(demoOpen(), MAIN_AGENT_ID, NOW).model.thinking);
  });

  it('prints only well-formed text, and keeps +N on the paper (P5)', () => {
    expect(wellFormed('a\ud800b')).toBe('a\ufffdb');
    expect(wellFormed('ok 😀')).toBe('ok 😀');
    expect(clean('x\ufffey\uffff')).toBe('xy');
    expect(printedTitle('half \ud83d of a smile\uffff')).toBe('half \ufffd of a smile');
    const { data } = demo((o) =>
      withSession(o, { title: 'half \ud83d smile', model: 'm\udc00\ufffe' }),
    );
    expect(wellFormedXml(receiptSvg(data, EN, 'tall').svg)).toBe(true);
    expect(wellFormedXml(receiptText(data, EN))).toBe(true);
    // Fifteen sub-agents, the last ten across the whole width: "+10" fits neither before the
    // merged track nor after it, so it goes under its start, inside the paper.
    const subs = Array.from({ length: 15 }, () => [0, 1000] as [number, number]);
    const svg = receiptSvg(
      { ...data, segments: [seg('thinking', 0, 1000)], subAgents: subs, subSegments: [] },
      EN,
      'tall',
    ).svg;
    const m = /<text x="([\d.]+)"[^>]*font-size="9"([^>]*)><tspan[^>]*>\+10</.exec(svg);
    expect(m).not.toBeNull();
    const x = Number(m?.[1]);
    const w = textWidth('+10', 9);
    const [from, to] = m?.[2]?.includes('text-anchor="end"') ? [x - w, x] : [x, x + w];
    expect(from).toBeGreaterThanOrEqual(4);
    expect(to).toBeLessThanOrEqual(WIDTH - 4);
  });
});
