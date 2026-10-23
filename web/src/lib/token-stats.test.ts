import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '../../../src/core/model.js';
import { totalTokens } from '../../../src/core/usage.js';
import { demoOpen } from '../test/demo';
import { contextSeries, insights, rollupByAgent, topRequests } from './token-stats';

describe('rollupByAgent', () => {
  it('rolls usage up the agent tree, with workflow and phase subtotals', () => {
    const rows = rollupByAgent(demoOpen()).map((r) => [
      r.kind,
      r.depth,
      r.label,
      totalTokens(r.total),
      r.kind === 'agent' ? totalTokens(r.own) : null,
    ]);
    expect(rows).toEqual([
      ['agent', 0, 'Main', 1_880_890, 219_790],
      ['agent', 1, 'Explore transcript format', 128_800, 128_800],
      ['workflow', 1, 'cc-recon', 1_532_300, null],
      ['phase', 2, 'Recon', 1_459_500, null],
      ['agent', 3, 'recon:live-write', 470_400, 470_400],
      ['agent', 3, 'recon:prior-art', 989_100, 989_100],
      ['phase', 2, 'Verify', 72_800, null],
      ['agent', 3, 'verify:live-write', 72_800, 72_800],
    ]);
  });

  it('keeps each bucket separate in the totals', () => {
    const main = rollupByAgent(demoOpen())[0];
    expect(main?.total).toMatchObject({
      cacheRead: 1_582_194,
      cacheWrite: 256_500,
      input: 156,
      output: 42_040,
      thinking: 27_050,
    });
  });
});

describe('contextSeries', () => {
  it('carries each point’s turn and call number, as the execution chain numbers them', () => {
    const series = contextSeries(demoOpen(), 'main');
    expect(series.map((p) => [p.turn, p.call])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 1],
      [2, 2],
    ]);
  });

  it('gives one point per finished request of the agent, in order', () => {
    const series = contextSeries(demoOpen(), 'main');
    expect(series.map((p) => [p.requestId, p.context, p.output, p.compacted])).toEqual([
      ['req_m1', 31_250, 820, false],
      ['req_m2', 34_900, 1_540, false],
      ['req_m3', 37_800, 420, false],
      ['req_m4', 52_400, 3_900, false],
      ['req_m5', 56_500, 260, false],
    ]);
  });

  it('guesses compactions from a sharp context drop when the adapter cannot mark them', () => {
    const open = demoOpen();
    open.diagnostics = { ...open.diagnostics, unavailable: ['compaction-markers'] };
    const m5 = open.requests.get('req_m5') as ModelRequest;
    const usage = {
      ...(m5.usage as NonNullable<ModelRequest['usage']>),
      cacheRead: 0,
      input: 9_000,
      cacheWrite: 9_000,
    };
    open.requests = new Map(open.requests).set('req_m5', { ...m5, usage });
    const series = contextSeries(open, 'main');
    expect(series.at(-1)).toMatchObject({ context: 18_000, compacted: true });
    expect(series.slice(0, -1).every((p) => !p.compacted)).toBe(true);
  });
});

describe('contextSeries trusts the adapter by default', () => {
  it('does not guess when the adapter marks compactions itself, even after a sharp drop', () => {
    const open = demoOpen();
    const m5 = open.requests.get('req_m5') as ModelRequest;
    const usage = {
      ...(m5.usage as NonNullable<ModelRequest['usage']>),
      cacheRead: 0,
      input: 9_000,
      cacheWrite: 9_000,
    };
    open.requests = new Map(open.requests).set('req_m5', { ...m5, usage });
    expect(contextSeries(open, 'main').every((p) => !p.compacted)).toBe(true);
  });
});

describe('contextSeries with exact compaction markers', () => {
  it('uses compactedBefore when the adapter reports it, ignoring the heuristic', () => {
    const open = demoOpen();
    const m3 = open.requests.get('req_m3') as ModelRequest;
    const m5 = open.requests.get('req_m5') as ModelRequest;
    const shrunk = {
      ...(m5.usage as NonNullable<ModelRequest['usage']>),
      cacheRead: 0,
      input: 9_000,
      cacheWrite: 9_000,
    };
    open.requests = new Map(open.requests)
      .set('req_m3', { ...m3, compactedBefore: true })
      .set('req_m5', { ...m5, usage: shrunk });
    const flags = contextSeries(open, 'main').map((p) => [p.requestId, p.compacted]);
    expect(flags).toEqual([
      ['req_m1', false],
      ['req_m2', false],
      ['req_m3', true],
      ['req_m4', false],
      ['req_m5', false],
    ]);
  });
});

describe('topRequests', () => {
  it('ranks finished requests by total tokens', () => {
    expect(topRequests(demoOpen(), 3).map((r) => r.id)).toEqual([
      'req_w2_9',
      'req_w2_8',
      'req_w2_7',
    ]);
  });

  it('can be limited to a set of agents', () => {
    expect(topRequests(demoOpen(), 2, new Set(['main'])).map((r) => r.id)).toEqual([
      'req_m5',
      'req_m4',
    ]);
  });
});

describe('insights', () => {
  it('calls out a cache-read-heavy session and an agent that spent over half', () => {
    const found = insights(demoOpen());
    expect(found.map((i) => i.key)).toEqual(['tokens.insightCacheRead', 'tokens.insightAgent']);
    expect(found[0]?.share).toBeCloseTo(1_582_194 / 1_880_890, 6);
    expect(found[1]).toMatchObject({ agentId: 'af00000000000002', label: 'recon:prior-art' });
    expect(found[1]?.share).toBeCloseTo(989_100 / 1_880_890, 6);
  });

  it('says nothing about a session without usage', () => {
    const open = demoOpen();
    open.requests = new Map();
    open.agents = new Map(
      [...open.agents].map(([id, a]) => [
        id,
        { ...a, usage: { ...a.usage, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } },
      ]),
    );
    expect(insights(open)).toEqual([]);
  });
});
