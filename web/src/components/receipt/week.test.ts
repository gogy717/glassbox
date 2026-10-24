import { describe, expect, it } from 'vitest';
import { createDemoSideSnapshots, createDemoSnapshot } from '../../../../src/core/fixtures/demo.js';
import type { SessionSnapshot } from '../../../../src/core/model.js';
import { createDemoWeek } from '../../../../src/server/week-demo.js';
import { createStore, type OpenSession } from '../../data/store';
import { demoWeek, WEEK_NOW, weekResult } from '../../test/week';
import { receiptData } from './data';
import { weekFileName } from './exportImage';
import { isoWeek, weekSerial } from './format';
import { COLUMNS, cols } from './text';
import { weekReceipt } from './week';
import { inkOf, weekSvg, windowLine } from './weekSvg';
import { weekText } from './weekText';

const EN = { paper: 'paper', locale: 'en', hideNames: false } as const;
const ZH = { ...EN, locale: 'zh' } as const;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** The text of an SVG: each text element's runs joined, the elements apart. */
const svgText = (svg: string) =>
  [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)]
    .map((t) =>
      [...(t[1] ?? '').matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]).join(''),
    )
    .join(' ');

function opened(snapshot: SessionSnapshot): OpenSession {
  const store = createStore();
  store.openSession(snapshot.session.id);
  store.applyEvent({ type: 'snapshot', sessionId: snapshot.session.id, snapshot });
  return store.getState().open as OpenSession;
}

describe('the weekly receipt’s figures', () => {
  it('prints a week of one session as that session’s own receipt (W3)', () => {
    const now = WEEK_NOW;
    for (const snap of [
      createDemoSnapshot(new Date(now)),
      ...createDemoSideSnapshots(new Date(now)),
    ]) {
      const r1 = receiptData(opened(snap), now);
      const w = weekReceipt(weekResult([snap], 'week', now));
      expect(w.sessions).toBe(1);
      expect(w.agentMs).toBe(r1.durationMs);
      expect(w.work.requests).toBe(r1.work.requests);
      expect(w.work.toolCalls).toBe(r1.work.toolCalls);
      expect(w.work.subAgents).toBe(r1.work.subAgents);
      expect(w.work.failures).toBe(r1.work.failures);
      expect(w.work.categories).toEqual(r1.work.categories);
      expect(w.tokens).toEqual(r1.tokens);
      expect(w.longest?.ms).toBe(r1.durationMs);
      expect(w.longest?.title).toBe(r1.title);
      expect(w.longest?.project).toBe(r1.project);
      // One CLI: the meta line names it and BY CLI is left out.
      expect(w.clis).toEqual([snap.session.agent]);
      expect(svgText(weekSvg(w, EN, 'tall').svg)).not.toContain('BY CLI');
    }
  });

  it('shares agent time by CLI in whole percents adding up to 100', () => {
    const w = weekReceipt(demoWeek());
    expect(w.byCli.length).toBe(5);
    expect(w.byCli.reduce((n, r) => n + r.share, 0)).toBe(100);
    expect(w.byCli.map((r) => r.ms)).toEqual([...w.byCli.map((r) => r.ms)].sort((a, b) => b - a));
    expect(w.agentMs).toBe(w.byCli.reduce((n, r) => n + r.ms, 0));
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

  it('lays this week out Monday to Sunday, the hours after now outlined, the cursor after now', () => {
    const w = weekReceipt(demoWeek('week'));
    expect(w.grid.flat().filter((c) => c.state === 'out')).toEqual([]);
    // Saturday 20:41: Saturday's 21:00 and on, and all of Sunday, are still to come.
    expect(w.grid.flat().filter((c) => c.state === 'future')).toHaveLength(3 + 24);
    expect(w.cursor).toEqual({ row: 5, col: 20 });
    expect(new Date(w.rows[0] as number).getDay()).toBe(1);
  });

  it('lays the last 7 days out with today last, its row holding both ends (R20)', () => {
    const r = demoWeek('7d');
    const w = weekReceipt(r);
    expect(r.window.hourStarts).toHaveLength(168);
    expect(w.grid.flat().every((c) => c.state === 'past')).toBe(true);
    expect(new Date(w.rows[6] as number).getDay()).toBe(6);
    expect(w.cursor).toEqual({ row: 6, col: 20 });
    // Today's row, right of the cursor: Saturday a week ago, the window's first hours.
    const first = r.window.hourStarts.slice(0, 3);
    const hourly = (h: number) =>
      r.sessions.reduce((n, s) => n + (s.hours[r.window.hourStarts.indexOf(h)] ?? 0), 0);
    expect(w.grid[6]?.slice(21).map((c) => c.ms)).toEqual(first.map(hourly));
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

describe('the weekly receipt as an image', () => {
  it('prints every line of the slip (D3), and withholds names when asked', () => {
    const w = weekReceipt(demoWeek());
    const shown = svgText(weekSvg(w, EN, 'tall').svg);
    for (const line of [
      'WEEKLY RECEIPT',
      'AGENT TIME',
      'WEEK',
      'Busiest hour',
      'After hours (22–06)',
      'BY CLI',
      'Longest session',
      'TOKENS',
      'TOTAL',
      'W43 · 2026 1019 → 1024 2041',
      'npx github:gogy717/glassbox',
    ])
      expect(shown).toContain(line);
    expect(shown).toContain('not reported · Grok');
    expect(shown).toContain(`${w.longest?.project} / ${w.longest?.title}`);
    const hidden = svgText(weekSvg(w, { ...EN, hideNames: true }, 'tall').svg);
    expect(hidden).not.toContain(w.longest?.title as string);
    expect(hidden).toContain(`· a session`);
    // The projects are still counted.
    expect(hidden).toContain(`${w.projects} projects`);
  });

  it('draws 168 hours, outlines the ones to come, and marks now on today’s row', () => {
    const svg = weekSvg(weekReceipt(demoWeek()), EN, 'tall').svg;
    const outlined = svg.match(/stroke-opacity="0.18"/g) ?? [];
    expect(outlined).toHaveLength(27);
    const cells = svg.match(/<rect x="[\d.]+" y="[\d.]+" width="(11|10|2)" height="\1"/g) ?? [];
    expect(cells).toHaveLength(168);
    expect(svg).toMatch(
      /<line x1="([\d.]+)" y1="[\d.]+" x2="\1" y2="[\d.]+" stroke="#1c1e22" stroke-width="1"\/>/,
    );
  });

  it('says a week with nothing in it had nothing, and points to the last 7 days', () => {
    const now = WEEK_NOW;
    const empty = weekReceipt(weekResult([], 'week', now));
    const shown = svgText(weekSvg(empty, EN, 'tall', { sessions: 37, agentMs: 23 * HOUR }).svg);
    expect(shown).toContain('No sessions this week.');
    expect(shown).toContain('Last 7 days has 37 sessions and 23h 00m of agent time.');
    expect(shown).not.toContain('AGENT TIME');
  });

  it('keeps a week not a day old quiet, with the way out (D3 Monday 00:05)', () => {
    const monday = new Date(2026, 9, 26, 0, 5).getTime();
    const w = weekReceipt(demoWeek('week', monday));
    expect(
      windowLine(
        w,
        'en',
        (k) => ({ thisWeek: 'This week', last7: 'Last 7 days', now: 'now' })[k as 'now'] ?? k,
      ),
    ).toBe('This week · Mon 26 Oct 2026, 00:00 → 00:05');
    const shown = svgText(
      weekSvg(w, EN, 'tall', { sessions: 37, agentMs: 23 * HOUR + 41 * MIN }).svg,
    );
    expect(shown).toContain('5 minutes into the week');
    expect(shown).toContain('Last 7 days has 37 sessions and 23h 41m of agent time.');
    expect(shown).not.toContain('WORK');
    expect(weekSerial('week', w.start, w.now)).toBe('W44 · 2026 1026 → 1026 0005');
  });

  it('heads the last 7 days from their first hour (R20)', () => {
    const w = weekReceipt(demoWeek('7d'));
    const shown = svgText(weekSvg(w, EN, 'tall').svg);
    expect(shown).toContain('Last 7 days · Sat 17 Oct 21:00 → now');
    expect(shown).toContain('7D · 2026 1017 2100 → 1024 2041');
    expect(svgText(weekSvg(w, ZH, 'tall').svg)).toContain('最近 7 天 · 10-17 周六 21:00 → 现在');
  });

  it('names the file by ISO week, or by the day for the last 7 days', () => {
    expect(weekFileName(weekReceipt(demoWeek('week')))).toBe('glassbox-week-2026-W43.png');
    expect(weekFileName(weekReceipt(demoWeek('7d')))).toBe('glassbox-7days-20261024.png');
    expect(isoWeek(new Date(2027, 0, 1).getTime())).toEqual([2026, 53]);
    expect(isoWeek(new Date(2026, 0, 1).getTime())).toEqual([2026, 1]);
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

  it('prints the grid as 7 aligned rows, a bar after now on today’s row', () => {
    const w = weekReceipt(demoWeek('7d'));
    const lines = weekText(w, EN).split('\n');
    const at = lines.indexOf('WEEK');
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
    const zgrid = zh.slice(zh.indexOf('本周') + 1, zh.indexOf('本周') + 8);
    expect(zgrid.every((l) => /^[·░▒█| ]{25} {2}[一二三四五六日]$/.test(l))).toBe(true);
  });
});
