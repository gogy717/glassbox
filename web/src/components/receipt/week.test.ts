import { afterEach, describe, expect, it } from 'vitest';
import { createDemoSideSnapshots, createDemoSnapshot } from '../../../../src/core/fixtures/demo.js';
import type { SessionSnapshot } from '../../../../src/core/model.js';
import { totalTokens } from '../../../../src/core/usage.js';
import { createDemoWeek } from '../../../../src/server/week-demo.js';
import { type WeekResult, type WeekSession, weekWindow } from '../../../../src/shared/week.js';
import { createStore, type OpenSession } from '../../data/store';
import { timeSegments, activeMs as unionMs } from '../../lib/time-stats';
import { demoWeek, WEEK_NOW, weekResult } from '../../test/week';
import { receiptData } from './data';
import { weekFileName } from './exportImage';
import { isoWeek, weekSerial } from './format';
import { INNER, type ReceiptOptions, textWidth } from './slip';
import { COLUMNS, cols } from './text';
import { weekReceipt } from './week';
import { inkOf, weekSvg, windowLine } from './weekSvg';
import { weekText } from './weekText';

const EN = { paper: 'paper', locale: 'en', hideNames: false } as const;
const ZH = { ...EN, locale: 'zh' } as const;
const MIN = 60_000;
const HOUR = 60 * MIN;

const XML: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&amp;': '&' };

/** The text of an SVG: each text element's runs joined, its markup unescaped. */
const svgTexts = (svg: string) =>
  [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((t) =>
    [...(t[1] ?? '').matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)]
      .map((m) => (m[1] ?? '').replace(/&(lt|gt|quot|amp);/g, (e) => XML[e] ?? e))
      .join(''),
  );
const svgText = (svg: string) => svgTexts(svg).join(' ');

function opened(snapshot: SessionSnapshot): OpenSession {
  const store = createStore();
  store.openSession(snapshot.session.id);
  store.applyEvent({ type: 'snapshot', sessionId: snapshot.session.id, snapshot });
  return store.getState().open as OpenSession;
}

/** The week's synthetic sessions with the most work, as of `now`. */
const busiest = (n: number, now = WEEK_NOW) =>
  createDemoWeek(now)
    .map((s) => ({ s, ms: weekResult([s], 'week', now).sessions[0]?.inWindow.activeMs ?? 0 }))
    .filter((x) => x.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, n)
    .map((x) => x.s);

describe('the weekly receipt’s figures', () => {
  it('prints a week of one session as its receipt: WORK, TOKENS, session time (W3, DR1)', () => {
    const now = WEEK_NOW;
    for (const snap of [
      createDemoSnapshot(new Date(now)),
      ...createDemoSideSnapshots(new Date(now)),
    ]) {
      const open = opened(snap);
      const r1 = receiptData(open, now);
      const w = weekReceipt(weekResult([snap], 'week', now));
      expect(w.sessions).toBe(1);
      expect(w.work.requests).toBe(r1.work.requests);
      expect(w.work.toolCalls).toBe(r1.work.toolCalls);
      expect(w.work.subAgents).toBe(r1.work.subAgents);
      expect(w.work.failures).toBe(r1.work.failures);
      expect(w.work.categories).toEqual(r1.work.categories);
      expect(w.tokens).toEqual(r1.tokens);
      // Session time and the longest session are its DURATION.
      expect(w.sessionMs).toBe(r1.durationMs);
      expect(w.longest?.ms).toBe(r1.durationMs);
      expect(w.longest?.title).toBe(r1.title);
      expect(w.longest?.project).toBe(r1.project);
      // Agent time is the grid's sum: every agent's work on the Timeline, queueing left out.
      const lanes = timeSegments(open, now);
      const work = lanes.reduce(
        (n, l) => n + unionMs(l.segments.filter((g) => g.kind !== 'waiting')),
        0,
      );
      expect(w.agentMs).toBe(work);
      expect(w.agentMs).toBe(w.grid.flat().reduce((n, c) => n + c.ms, 0));
      // One CLI: the meta line names it and BY CLI is left out; session time only with sub-agents.
      expect(w.clis).toEqual([snap.session.agent]);
      const shown = svgText(weekSvg(w, EN, 'tall').svg);
      expect(shown).not.toContain('BY CLI');
      expect(shown.includes('Session time')).toBe(r1.work.subAgents > 0);
    }
  });

  it('adds two sessions’ figures up, each one of them (C2)', () => {
    const [a, b] = busiest(2);
    if (!a || !b) throw new Error('no sessions');
    const one = weekReceipt(weekResult([a]));
    const two = weekReceipt(weekResult([b]));
    const both = weekReceipt(weekResult([a, b]));
    for (const k of ['requests', 'toolCalls', 'subAgents', 'failures'] as const)
      expect(both.work[k]).toBe(one.work[k] + two.work[k]);
    expect(both.agentMs).toBe(one.agentMs + two.agentMs);
    expect(both.sessionMs).toBe(one.sessionMs + two.sessionMs);
    for (const k of ['cacheRead', 'cacheWrite', 'uncached', 'output', 'thinking', 'total'] as const)
      expect(both.tokens[k]).toBe(one.tokens[k] + two.tokens[k]);
    const cats = (w: typeof both) => w.work.categories.reduce((n, c) => n + c.count, 0);
    expect(cats(both)).toBe(cats(one) + cats(two));
    expect(both.sessions).toBe(2);
  });

  it('takes the longest session by its own clock, wherever it is listed (C2)', () => {
    const top = busiest(3);
    const [first, second, third] = top;
    if (!first || !second || !third) throw new Error('no sessions');
    for (const order of [
      [second, first, third],
      [third, second, first],
      [first, third, second],
    ]) {
      const r = weekResult(order);
      r.sessions = order.map((s) => r.sessions.find((x) => x.id === s.session.id) as WeekSession);
      const w = weekReceipt(r);
      expect(w.longest?.ms).toBe(Math.max(...r.sessions.map((s) => s.inWindow.activeMs)));
      expect(w.longest?.title).toBe(first.session.title);
    }
  });

  it('splits agent time by CLI, rows adding up to it, the CLIs under 1% as "<1%" (DR1, DR4)', () => {
    const w = weekReceipt(demoWeek());
    expect(w.byCli.length).toBe(5);
    expect(w.byCli.reduce((n, r) => n + r.ms, 0)).toBe(w.agentMs);
    expect(w.byCli.reduce((n, r) => n + (r.share === '<1' ? 0 : r.share), 0)).toBe(100);
    // A CLI that barely worked: under 1%, not 0%.
    const [big] = busiest(1);
    const tiny = createDemoSideSnapshots(new Date(WEEK_NOW))[0] as SessionSnapshot;
    tiny.session = { ...tiny.session, agent: 'codex' };
    // One short call: well under 1% of the other's hours.
    tiny.requests = tiny.requests.slice(0, 1);
    tiny.toolCalls = [];
    const lopsided = weekReceipt(weekResult([big as SessionSnapshot, tiny]));
    expect(lopsided.byCli.map((r) => r.share)).toEqual([100, '<1']);
    expect(svgText(weekSvg(lopsided, EN, 'tall').svg)).toContain('<1%');
  });

  it('finds the busiest hour and the share after hours in the same hours as the grid', () => {
    const w = weekReceipt(demoWeek());
    const cells = w.grid.flat();
    expect(w.busiest?.ms).toBe(Math.max(...cells.map((c) => c.ms)));
    const night = w.grid.reduce(
      (n, row) => n + row.reduce((m, c, h) => (h >= 22 || h < 6 ? m + c.ms : m), 0),
      0,
    );
    expect(w.afterHours).toBeCloseTo(night / cells.reduce((n, c) => n + c.ms, 0), 10);
  });

  it('lays this week out Monday to Sunday, the hours after its end outlined, the cursor there', () => {
    const w = weekReceipt(demoWeek('week'));
    expect(w.grid.flat().filter((c) => c.state === 'out')).toEqual([]);
    // Saturday 20:41: Saturday's 21:00 and on, and all of Sunday, are still to come.
    expect(w.grid.flat().filter((c) => c.state === 'future')).toHaveLength(3 + 24);
    expect(w.cursor).toEqual({ row: 5, col: 20 });
    expect(new Date(w.rows[0] as number).getDay()).toBe(1);
  });

  it('lays the last 7 days out by their 168 hours, today last holding both ends (R20, R23)', () => {
    const r = demoWeek('7d');
    const w = weekReceipt(r);
    expect(r.window.hourStarts).toHaveLength(168);
    expect(w.grid.flat().every((c) => c.state === 'past')).toBe(true);
    expect(new Date(w.rows[6] as number).getDay()).toBe(6);
    expect(w.cursor).toEqual({ row: 6, col: 20 });
    // Today's row, right of the cursor: Saturday a week ago, the window's first hours.
    const hourly = (i: number) => r.sessions.reduce((n, s) => n + (s.hours[i] ?? 0), 0);
    expect(w.grid[6]?.slice(21).map((c) => c.ms)).toEqual([0, 1, 2].map(hourly));
  });

  it('prints the receipt’s end where its data is from, not when it was asked (C5)', () => {
    const r = demoWeek('week');
    const asOf = WEEK_NOW - 2 * HOUR - 10 * MIN; // 18:31
    const w = weekReceipt({ ...r, asOf });
    expect(w.now).toBe(asOf);
    expect(w.cursor).toEqual({ row: 5, col: 18 });
    expect(w.grid[5]?.slice(19).every((c) => c.state === 'future')).toBe(true);
    expect(svgText(weekSvg(w, EN, 'tall').svg)).toContain('Sat 21 Nov · 18:31');
    expect(weekSerial(w.kind, w.start, w.now)).toBe('W47 · 2026 1116 → 1121 1831');
  });

  it('inks an hour by its agent minutes: none, under 10, under 40, more', () => {
    const cell = (min: number) => inkOf({ ms: min * MIN, state: 'past' });
    expect([cell(0), cell(9), cell(10), cell(39), cell(40), cell(130)]).toEqual([
      'none',
      'low',
      'mid',
      'mid',
      'high',
      'high',
    ]);
    expect(inkOf({ ms: 0, state: 'future' })).toBe('future');
  });
});

describe('the last 7 days across a change of the clocks (C3)', () => {
  const tz = process.env.TZ;
  afterEach(() => {
    // Assigning undefined would set the zone named "undefined" (UTC) for every later test.
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  /** One session working i+1 minutes in the window's i-th hour: every hour told apart. */
  const marked = (now: number): WeekResult => {
    const window = weekWindow('7d', now);
    const hours = window.hourStarts.map((_, i) => (i + 1) * MIN);
    const session: WeekSession = {
      id: 'x',
      agent: 'claude-code',
      project: 'p',
      cwd: null,
      title: null,
      tags: [],
      reportsUsage: false,
      inWindow: {
        activeMs: 0,
        agentMs: hours.reduce((a, b) => a + b, 0),
        requests: 1,
        toolCalls: 0,
        toolCats: {},
        subAgents: 0,
        failures: 0,
        usage: {
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          output: 0,
          thinking: 0,
          webSearch: 0,
          webFetch: 0,
        },
      },
      hours,
    };
    return {
      window,
      sessions: [session],
      asOf: now,
      stats: { considered: 1, read: 1, cached: 0, failed: 0, bytes: 0, ms: 0 },
    };
  };

  for (const [what, at] of [
    ['clocks back (Sun 25 Oct, 03:00 → 02:00)', [2026, 9, 28, 12, 30]],
    ['clocks forward (Sun 29 Mar, 02:00 → 03:00)', [2026, 3, 1, 12, 30]],
  ] as const)
    it(`gives each of its 168 hours a cell of its own: ${what}`, () => {
      process.env.TZ = 'Europe/Berlin';
      const now = new Date(...(at as [number, number, number, number, number])).getTime();
      const r = marked(now);
      const w = weekReceipt(r);
      const cells = w.grid.flat().filter((c) => c.state === 'past');
      expect(cells).toHaveLength(168);
      expect(cells.map((c) => c.ms).sort((a, b) => a - b)).toEqual(
        (r.sessions[0] as WeekSession).hours,
      );
      expect(w.cursor).toEqual({ row: 6, col: 12 });
    });
});

describe('the weekly receipt as an image', () => {
  it('prints every line of the slip (D3), and withholds names when asked', () => {
    const w = weekReceipt(demoWeek());
    const shown = svgText(weekSvg(w, EN, 'tall').svg);
    for (const line of [
      'WEEKLY RECEIPT',
      'AGENT TIME',
      'Session time',
      'WEEK',
      'Busiest hour',
      'After hours (22–06)',
      'BY CLI',
      'Longest session',
      'TOKENS',
      'TOTAL',
      'W47 · 2026 1116 → 1121 2041',
      'npx github:gogy717/glassbox',
    ])
      expect(shown).toContain(line);
    expect(shown).toContain('not reported · Grok');
    expect(shown).toContain(`${w.longest?.project} / ${w.longest?.title}`);
    const hidden = svgText(weekSvg(w, { ...EN, hideNames: true }, 'tall').svg);
    expect(hidden).not.toContain(w.longest?.title as string);
    expect(hidden).toContain('· a session');
    // The projects are still counted.
    expect(hidden).toContain(`${w.projects} projects`);
  });

  it('draws 168 hours, outlines the ones to come, and marks the end on its row', () => {
    const svg = weekSvg(weekReceipt(demoWeek()), EN, 'tall').svg;
    const outlined = svg.match(/stroke-opacity="0.18"/g) ?? [];
    expect(outlined).toHaveLength(27);
    const cells = svg.match(/<rect x="[\d.]+" y="[\d.]+" width="(11|10|2)" height="\1"/g) ?? [];
    expect(cells).toHaveLength(168);
    expect(svg).toMatch(
      /<line x1="([\d.]+)" y1="[\d.]+" x2="\1" y2="[\d.]+" stroke="#1c1e22" stroke-width="1"\/>/,
    );
  });

  it('notes the sessions that report no usage on one line, folded to fit (DR3)', () => {
    const all = [createDemoSnapshot(new Date(WEEK_NOW)), ...createDemoWeek(WEEK_NOW)];
    const silent = (agents: string[]) =>
      all.map((s) =>
        agents.includes(s.session.agent)
          ? { ...s, requests: s.requests.map((q) => ({ ...q, usage: null })) }
          : s,
      );
    const notes = (agents: string[], o: ReceiptOptions = EN) =>
      svgTexts(weekSvg(weekReceipt(weekResult(silent(agents))), o, 'tall').svg).filter(
        (t) => t.startsWith('not reported') || t.startsWith('未报告'),
      );
    expect(notes(['grok'])).toEqual([expect.stringMatching(/^not reported · Grok \d+ sessions$/)]);
    expect(notes(['codex', 'grok'])).toEqual([
      expect.stringMatching(/^not reported · Codex \d+ · Grok \d+ sessions$/),
    ]);
    // Too many to name: still one line, never cut.
    const folded = notes(['codex', 'grok', 'opencode', 'oh-my-pi']);
    expect(folded).toHaveLength(1);
    expect(textWidth(folded[0] as string, 11)).toBeLessThanOrEqual(INNER);
    expect(folded[0]).not.toContain('…');
    expect(notes(['codex', 'grok', 'opencode', 'oh-my-pi'], { ...EN, locale: 'zh' })).toHaveLength(
      1,
    );
  });

  it('says a week with nothing in it had nothing, and points to the last 7 days', () => {
    const empty = weekReceipt(weekResult([], 'week'));
    const shown = svgText(weekSvg(empty, EN, 'tall', { sessions: 37, agentMs: 23 * HOUR }).svg);
    expect(shown).toContain('No sessions this week.');
    expect(shown).toContain('Last 7 days has 37 sessions and 23h 00m of agent time.');
    expect(shown).not.toContain('AGENT TIME');
  });

  it('keeps only a week of under half an hour quiet (DR2)', () => {
    const monday = new Date(2026, 10, 23, 0, 5).getTime();
    const w = weekReceipt(demoWeek('week', monday));
    expect(w.agentMs).toBeLessThan(30 * MIN);
    expect(windowLine(w.kind, w.start, w.now, 'en', (k) => k)).toBe(
      'thisWeek · Mon 23 Nov 2026, 00:00 → 00:05',
    );
    const shown = svgText(
      weekSvg(w, EN, 'tall', { sessions: 37, agentMs: 23 * HOUR + 41 * MIN }).svg,
    );
    expect(shown).toMatch(/5 minutes into the week · \d+ sessions? · \d+m( \d\ds)?/);
    expect(shown).toContain('Last 7 days has 37 sessions and 23h 41m of agent time.');
    expect(shown).not.toContain('WORK');
    expect(weekSerial('week', w.start, w.now)).toBe('W48 · 2026 1123 → 1123 0005');
    // A Monday evening of work is a receipt, not a quiet slip.
    const evening = new Date(2026, 10, 23, 19, 0).getTime();
    const full = weekReceipt(demoWeek('week', evening));
    expect(full.agentMs).toBeGreaterThanOrEqual(30 * MIN);
    expect(svgText(weekSvg(full, EN, 'tall').svg)).toContain('WORK');
  });

  it('heads the last 7 days from their first hour, as LAST 7 DAYS (R20, C4)', () => {
    const w = weekReceipt(demoWeek('7d'));
    const shown = svgText(weekSvg(w, EN, 'tall').svg);
    expect(shown).toContain('Last 7 days · Sat 14 Nov 21:00 → now');
    expect(shown).toContain('LAST 7 DAYS');
    expect(shown).toContain('7D · 2026 1114 2100 → 1121 2041');
    expect(svgText(weekSvg(w, ZH, 'tall').svg)).toContain('最近 7 天 · 11-14 周六 21:00 → 现在');
  });

  it('names the file by ISO week, as the serial does, or by the day for the last 7 days', () => {
    expect(weekFileName(weekReceipt(demoWeek('week')))).toBe('glassbox-week-2026-W47.png');
    expect(weekFileName(weekReceipt(demoWeek('7d')))).toBe('glassbox-7days-20261121.png');
    expect(isoWeek(new Date(2027, 0, 1).getTime())).toEqual([2026, 53]);
    expect(isoWeek(new Date(2026, 0, 1).getTime())).toEqual([2026, 1]);
    const jan = new Date(2026, 0, 26).getTime();
    expect(weekSerial('week', jan, jan + HOUR)).toMatch(/^W05 · /);
  });
});

describe('the weekly receipt as text', () => {
  const ultra = () => {
    const all = [createDemoSnapshot(new Date(WEEK_NOW)), ...createDemoWeek(WEEK_NOW)];
    const many: SessionSnapshot[] = [];
    for (let k = 0; k < 4; k++)
      for (const s of all)
        many.push({ ...s, session: { ...s.session, id: `${s.session.id}-${k}` } });
    return weekResult(many, 'week');
  };

  it('fits 60 lines of 44 columns, in both languages, any week (W7)', () => {
    for (const r of [demoWeek('week'), demoWeek('7d'), ultra()])
      for (const o of [EN, ZH, { ...EN, hideNames: true }]) {
        const lines = weekText(weekReceipt(r), o).split('\n');
        expect(lines.length).toBeLessThanOrEqual(60);
        expect(lines.filter((l) => cols(l) > COLUMNS)).toEqual([]);
      }
  });

  it('names no title and no project when names are withheld (C2)', () => {
    const w = weekReceipt(demoWeek());
    for (const o of [EN, ZH]) {
      const text = weekText(w, { ...o, hideNames: true });
      expect(text).not.toContain(w.longest?.title as string);
      expect(text).not.toContain(`${w.longest?.project} /`);
      expect(text).toContain(o.locale === 'en' ? '· a session' : '· 一个会话');
    }
    expect(weekText(w, EN)).toContain(`${w.longest?.project} / ${w.longest?.title}`);
  });

  it('prints the grid as 7 aligned rows, a bar after the end on its row', () => {
    const w = weekReceipt(demoWeek('7d'));
    const lines = weekText(w, EN).split('\n');
    const at = lines.indexOf('LAST 7 DAYS');
    const grid = lines.slice(at + 1, at + 8);
    expect(grid.map((l) => l.slice(0, 3))).toEqual([
      'Su ',
      'Mo ',
      'Tu ',
      'We ',
      'Th ',
      'Fr ',
      'Sa ',
    ]);
    expect(new Set(grid.map((l) => l.length)).size).toBe(1);
    expect(grid[6]?.[3 + 21]).toBe('|');
    expect(grid.slice(0, 6).every((l) => l[3 + 21] === ' ')).toBe(true);
    // In Chinese the hours come first, the weekday after: aligned whatever width CJK takes.
    const zh = weekText(w, ZH).split('\n');
    const zgrid = zh.slice(zh.indexOf('最近 7 天') + 1, zh.indexOf('最近 7 天') + 8);
    expect(zgrid.every((l) => /^[·░▒█| ]{25} {2}[一二三四五六日]$/.test(l))).toBe(true);
  });

  it('prints the session time beside agent time, and the note on one line', () => {
    const text = weekText(weekReceipt(demoWeek()), EN);
    expect(text).toMatch(/^Session time \.+ \d+h \d\dm$/m);
    expect(text).toMatch(/^not reported · Grok \d+ sessions$/m);
    expect(totalTokens).toBeDefined();
  });
});
