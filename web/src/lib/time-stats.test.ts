import { describe, expect, it } from 'vitest';
import { DEMO_NOW, demoOpen, pendingFor, withRunningTool } from '../test/demo';
import {
  activeMs,
  breakWidth,
  buildTimeScale,
  mergeForDisplay,
  type Segment,
  slowest,
  timeBreakdown,
  timeSegments,
} from './time-stats';

const NOW = DEMO_NOW.getTime();
/** Demo times are seconds after t0 = now − 40 min. */
const at = (sec: number) => NOW - 40 * 60_000 + sec * 1000;
const near = (a: number | undefined, b: number) =>
  expect(Math.abs((a ?? Number.NaN) - b)).toBeLessThanOrEqual(1);

describe('timeSegments', () => {
  it('gives one lane per agent: main, sub-agents, then workflow agents by phase', () => {
    const lanes = timeSegments(demoOpen(), NOW);
    expect(lanes.map((l) => [l.agentId, l.group])).toEqual([
      ['main', null],
      ['a1b2c3d4e5f60718', null],
      ['af00000000000001', 'cc-recon · Recon'],
      ['af00000000000002', 'cc-recon · Recon'],
      ['af00000000000003', 'cc-recon · Verify'],
    ]);
  });

  it('splits a request into thinking then generating, followed by its tools', () => {
    const main = timeSegments(demoOpen(), NOW)[0];
    const m1 = main?.segments.filter((s) => s.requestId === 'req_m1') ?? [];
    expect(m1.map((s) => s.kind)).toEqual(['thinking', 'generating', 'tool']);
    near(m1[0]?.start, at(2));
    near(m1[0]?.end, at(10.4));
    near(m1[1]?.end, at(16));
    expect(m1[2]).toMatchObject({ refId: 'tu_m1a', category: 'explore' });
    near(m1[2]?.end, at(16.4));
  });

  it('shows waiting when the first block came later than the thinking explains', () => {
    const open = demoOpen();
    const m1 = open.requests.get('req_m1');
    if (!m1) throw new Error('fixture');
    const blocks = m1.blocks.map((b) => (b.kind === 'thinking' ? { ...b, durationMs: 6_400 } : b));
    open.requests = new Map(open.requests).set('req_m1', { ...m1, blocks });
    const segs = timeSegments(open, NOW)[0]?.segments.filter((s) => s.requestId === 'req_m1');
    expect(segs?.map((s) => s.kind)).toEqual(['waiting', 'thinking', 'generating', 'tool']);
    near(segs?.[0]?.end, at(4));
  });

  it('runs in-flight requests and running tools up to now', () => {
    const lanes = timeSegments(demoOpen(), NOW);
    const m6 = lanes[0]?.segments.find((s) => s.requestId === 'req_m6');
    expect(m6).toMatchObject({ kind: 'thinking', live: true, end: NOW });
    near(m6?.start, at(2317));
    const tool = lanes[3]?.segments.find((s) => s.refId === 'tu_w2_9');
    expect(tool).toMatchObject({ kind: 'tool', live: true, end: NOW });
  });

  it('lets parallel workflow agents overlap', () => {
    const lanes = timeSegments(demoOpen(), NOW);
    const span = (i: number) => {
      const segs = lanes[i]?.segments ?? [];
      return [Math.min(...segs.map((s) => s.start)), Math.max(...segs.map((s) => s.end))];
    };
    const [s2, e2] = span(3);
    const [s3, e3] = span(4);
    expect(Math.max(s2 as number, s3 as number)).toBeLessThan(Math.min(e2 as number, e3 as number));
  });
});

describe('timeBreakdown', () => {
  it('splits the main agent’s time into model, tools by kind, and idle between turns', () => {
    const b = timeBreakdown(demoOpen(), 'main', NOW);
    expect(b.model.thinking).toBeCloseTo(141_800, -1);
    expect(b.model.generating).toBeCloseTo(39_200, -1);
    expect(b.model.waiting).toBe(0);
    expect(b.tools).toEqual({ explore: 550, edit: 50, delegate: 250 });
    near(b.idle, 2_214_000);
  });
});

describe('timeBreakdown with parallel tools', () => {
  it('counts overlapping tools of one kind once (wall-clock), not summed', () => {
    const open = demoOpen();
    const base = open.toolCalls.get('tu_m4a');
    if (!base) throw new Error('fixture');
    const start = Date.parse(base.startedAt as string);
    const tool = (id: string, offsetMin: number, lenMin: number) => ({
      ...base,
      id,
      startedAt: new Date(start + offsetMin * 60_000).toISOString(),
      endedAt: new Date(start + (offsetMin + lenMin) * 60_000).toISOString(),
      durationMs: lenMin * 60_000,
    });
    open.toolCalls = new Map(open.toolCalls)
      .set('tu_m4a', tool('tu_m4a', 0, 10))
      .set('tu_m4b', tool('tu_m4b', 0, 10))
      .set('tu_p3', tool('tu_p3', 5, 10));
    expect(timeBreakdown(open, 'main', NOW).tools.delegate).toBe(15 * 60_000);
  });
});

describe('slowest', () => {
  it('ranks requests and tool calls by how long they took (or have been running)', () => {
    const top = slowest(demoOpen(), null, NOW, 3);
    expect(top.map((s) => [s.kind, s.id])).toEqual([
      ['request', 'req_w3_3'],
      ['tool', 'tu_w2_9'],
      ['request', 'req_m6'],
    ]);
    near(top[0]?.durationMs, 1_588_000);
  });

  it('can be limited to some agents', () => {
    const top = slowest(demoOpen(), new Set(['main']), NOW, 2);
    expect(top.map((s) => s.id)).toEqual(['req_m6', 'req_m4']);
  });
});

describe('buildTimeScale', () => {
  it('maps time to x linearly inside activity and collapses long idle gaps into breaks', () => {
    const s = buildTimeScale(
      [
        [0, 10],
        [5, 20],
        [1000, 1010],
      ],
      { pxPerMs: 1, gapMs: 100, breakPx: 20 },
    );
    expect([s.x(0), s.x(10), s.x(20), s.x(1000), s.x(1010)]).toEqual([0, 10, 20, 40, 50]);
    expect(s.width).toBe(50);
    expect(s.breaks).toEqual([{ x0: 20, x1: 40, from: 20, to: 1000 }]);
    // A time inside a break sits proportionally within it.
    expect(s.x(510)).toBe(30);
  });

  it('keeps short gaps to scale', () => {
    const s = buildTimeScale(
      [
        [0, 10],
        [50, 60],
      ],
      { pxPerMs: 2, gapMs: 100, breakPx: 20 },
    );
    expect([s.x(10), s.x(50), s.width]).toEqual([20, 100, 120]);
    expect(s.breaks).toEqual([]);
  });

  it('handles no activity', () => {
    const s = buildTimeScale([], { pxPerMs: 1, gapMs: 100, breakPx: 20 });
    expect(s.width).toBe(0);
    expect(s.x(123)).toBe(0);
  });
});

/** 66 back-to-back short requests (≈11.65 s each, 769 s in all) spread over 17 minutes. */
function denseLane(): Segment[] {
  const segs: Segment[] = [];
  const t0 = Date.parse('2026-10-23T15:33:00Z');
  for (let i = 0; i < 66; i++) {
    const start = t0 + i * 15_450;
    segs.push(
      { kind: 'thinking', start, end: start + 7_000, refId: `r${i}`, requestId: `r${i}` },
      {
        kind: 'generating',
        start: start + 7_000,
        end: start + 11_000,
        refId: `r${i}`,
        requestId: `r${i}`,
      },
      {
        kind: 'tool',
        start: start + 11_000,
        end: start + 11_650,
        refId: `t${i}`,
        requestId: `r${i}`,
        category: 'run',
      },
    );
  }
  return segs;
}

describe('mergeForDisplay', () => {
  it('folds a dense run of sub-pixel requests into one visible block covering the active span', () => {
    const segs = denseLane();
    const start = segs[0]?.start as number;
    const end = segs.at(-1)?.end as number;
    // ~10 s per pixel: every request is about one pixel wide.
    const x = (t: number) => (t - start) / 10_000;
    const shown = mergeForDisplay(segs, x);
    expect(shown.length).toBeGreaterThan(0);
    const covered = shown.reduce((sum, d) => sum + (d.x1 - d.x0), 0);
    expect(Math.abs(covered - x(end))).toBeLessThan(2);
    expect(shown[0]).toMatchObject({ merged: true, requests: 66, tools: 66, kind: 'thinking' });
    expect(shown[0]?.busyMs).toBe(66 * 11_650);
  });

  it('keeps segments that are wide enough to see on their own', () => {
    const segs = denseLane().slice(0, 6);
    const start = segs[0]?.start as number;
    const x = (t: number) => (t - start) / 100; // 10 px per second
    const shown = mergeForDisplay(segs, x);
    expect(shown.map((d) => [d.kind, d.merged])).toEqual([
      ['thinking', false],
      ['generating', false],
      ['tool', false],
      ['thinking', false],
      ['generating', false],
      ['tool', false],
    ]);
  });

  it('gives every block at least the minimum width', () => {
    const shown = mergeForDisplay(denseLane().slice(2, 3), (t) => t / 1_000_000);
    expect((shown[0]?.x1 ?? 0) - (shown[0]?.x0 ?? 0)).toBeGreaterThanOrEqual(1.5);
  });

  it('does not bridge a visible gap between tiny segments', () => {
    const seg = (start: number, end: number, id: string): Segment => ({
      kind: 'thinking',
      start,
      end,
      refId: id,
      requestId: id,
    });
    // 1 px wide pieces: two touching, then a 5 px gap, then one more.
    const shown = mergeForDisplay([seg(0, 1, 'a'), seg(1, 2, 'b'), seg(7, 8, 'c')], (t) => t);
    expect(shown.map((d) => [d.x0, d.merged, d.requests])).toEqual([
      [0, true, 2],
      [7, false, 1],
    ]);
  });
});

describe('activeMs', () => {
  it('counts overlapping time once', () => {
    expect(
      activeMs([
        { kind: 'thinking', start: 0, end: 10, refId: 'a', requestId: 'a' },
        { kind: 'tool', start: 5, end: 20, refId: 'b', requestId: 'a' },
        { kind: 'tool', start: 30, end: 40, refId: 'c', requestId: 'a' },
      ]),
    ).toBe(30);
  });
});

describe('breakWidth', () => {
  it('shares about a fifth of the view between idle breaks, between 10 and 64 px each', () => {
    expect(breakWidth(800, 1)).toBe(64);
    expect(breakWidth(800, 4)).toBe(40);
    expect(breakWidth(800, 10)).toBe(16);
    expect(breakWidth(800, 40)).toBe(10);
    expect(breakWidth(800, 0)).toBe(64);
  });
});

describe('waiting for approval', () => {
  const open = withRunningTool(demoOpen(), 'tu_m1a');
  const awaiting = pendingFor('tu_m1a');

  it('draws a tool blocked on a permission prompt as its own live segment', () => {
    const main = timeSegments(open, NOW, awaiting)[0];
    const seg = main?.segments.find((s) => s.refId === 'tu_m1a');
    expect(seg).toMatchObject({ kind: 'approval', live: true, end: NOW });
    expect(timeSegments(open, NOW)[0]?.segments.find((s) => s.refId === 'tu_m1a')?.kind).toBe(
      'tool',
    );
  });

  it('counts that time as waiting for the person, not as tool time', () => {
    const plain = timeBreakdown(open, 'main', NOW);
    const b = timeBreakdown(open, 'main', NOW, awaiting);
    const toolStart = Date.parse(open.toolCalls.get('tu_m1a')?.startedAt ?? '');
    expect(b.approval).toBe(NOW - toolStart);
    expect(plain.approval).toBe(0);
    expect(b.tools.explore ?? 0).toBeLessThan(plain.tools.explore ?? 0);
  });

  it('splits an answered prompt out of the tool’s own time', () => {
    const plainOpen = demoOpen();
    const tool = plainOpen.toolCalls.get('tu_m1a');
    const start = Date.parse(tool?.startedAt ?? '');
    const end = start + (tool?.durationMs ?? 0);
    const answered = new Map([['tu_m1a', { requestedAt: start + 100, decidedAt: start + 300 }]]);
    const segs = (timeSegments(plainOpen, NOW, answered)[0]?.segments ?? []).filter(
      (s) => s.refId === 'tu_m1a',
    );
    expect(segs.map((s) => [s.kind, s.start - start, s.end - start, !!s.live])).toEqual([
      ['tool', 0, 100, false],
      ['approval', 100, 300, false],
      ['tool', 300, end - start, false],
    ]);
    const plain = timeBreakdown(plainOpen, 'main', NOW);
    const b = timeBreakdown(plainOpen, 'main', NOW, answered);
    expect(b.approval).toBe(200);
    expect(b.tools.explore).toBe((plain.tools.explore ?? 0) - 200);
  });

  it('ignores a window that does not overlap the tool', () => {
    const plainOpen = demoOpen();
    const stray = new Map([['tu_m1a', { requestedAt: 1, decidedAt: 2 }]]);
    expect(timeBreakdown(plainOpen, 'main', NOW, stray)).toEqual(
      timeBreakdown(plainOpen, 'main', NOW),
    );
  });
});
