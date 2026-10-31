import { describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '../../../src/core/fixtures/demo.js';
import type { Diagnostics, ModelRequest, TokenUsage } from '../../../src/core/model.js';
import { emptyUsage } from '../../../src/core/usage.js';
import { stageCacheBreaks } from '../../../src/server/demo-cache-breaks.js';
import { fromSnapshot } from '../data/store';
import { DEMO_NOW } from '../test/demo';
import {
  agentCacheBreaks,
  type CacheBreaksInput,
  cacheBreakCost,
  cacheBreaks,
  cacheBreaksById,
} from './cache-breaks';
import { DEFAULT_PRICES } from './prices';

const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

interface Spec {
  id: string;
  /** Seconds after T0 the request started; it ends 10 s later. */
  at: number;
  read: number;
  write: number;
  input?: number;
  agentId?: string;
  shape?: string;
  compacted?: boolean;
  /** Writes that went to the 1-hour cache. */
  write1h?: number;
  model?: string;
}

function req(s: Spec): ModelRequest {
  const usage: TokenUsage = {
    ...emptyUsage(),
    input: s.input ?? 6,
    cacheRead: s.read,
    cacheWrite: s.write,
    cacheWrite5m: s.write - (s.write1h ?? 0),
    cacheWrite1h: s.write1h ?? 0,
    output: 500,
  };
  return {
    id: s.id,
    agentId: s.agentId ?? 'main',
    turnId: 't1',
    index: 1,
    model: s.model ?? 'claude-opus-5-5',
    effort: null,
    startedAt: iso(s.at),
    firstBlockAt: iso(s.at + 5),
    endedAt: iso(s.at + 10),
    status: 'complete',
    stopReason: 'end_turn',
    usage,
    blocks: [],
    toolCallIds: [],
    hasDetail: true,
    error: null,
    ...(s.compacted ? { compactedBefore: true } : {}),
    ...(s.shape ? { shapeHash: s.shape } : {}),
  };
}

/** A conversation growing by 4K a request: each one reads the previous request's whole context. */
function growing(n: number, from = 0, agentId = 'main'): ModelRequest[] {
  const out: ModelRequest[] = [];
  let context = 40_000;
  for (let i = 0; i < n; i++) {
    const read = i === 0 ? 0 : context;
    const next = context + (i === 0 ? 0 : 4_000);
    out.push(
      req({
        id: `${agentId}-${from + i}`,
        agentId,
        at: (from + i) * 30,
        read,
        write: next - read - 6,
        shape: 'shape-1',
      }),
    );
    context = next;
  }
  return out;
}

const diagnostics = (unavailable: string[] = []): Diagnostics => ({
  unknownRecordTypes: {},
  parseErrors: 0,
  unavailable,
});

const input = (requests: ModelRequest[], unavailable: string[] = []): CacheBreaksInput => ({
  requests: new Map(requests.map((r) => [r.id, r])),
  diagnostics: diagnostics(unavailable),
});

describe('agentCacheBreaks', () => {
  it('finds nothing while each request reads the previous context back', () => {
    expect(agentCacheBreaks(growing(6))).toEqual([]);
  });

  it('never counts the first request, however little it read', () => {
    const [first] = growing(1);
    expect(agentCacheBreaks([first as ModelRequest])).toEqual([]);
  });

  it('says compaction first when the request followed one', () => {
    const reqs = growing(4);
    reqs.push(
      req({ id: 'c', at: 200, read: 10_000, write: 8_000, compacted: true, shape: 'shape-2' }),
    );
    const [b] = agentCacheBreaks(reqs);
    expect(b?.request.id).toBe('c');
    expect(b?.reason).toBe('compaction');
  });

  it('says shape when the system prompt or tools changed', () => {
    const reqs = growing(4);
    reqs.push(req({ id: 's', at: 120, read: 0, write: 52_000, shape: 'shape-2' }));
    expect(agentCacheBreaks(reqs).map((b) => [b.request.id, b.reason])).toEqual([['s', 'shape']]);
  });

  it('does not read a missing shape hash as a change', () => {
    const reqs = growing(4).map(({ shapeHash: _, ...r }) => r);
    reqs.push(req({ id: 'u', at: 120, read: 0, write: 52_000 }));
    expect(agentCacheBreaks(reqs)[0]?.reason).toBe('unknown');
  });

  it('says expired when more than five minutes passed since the previous request ended', () => {
    const reqs = growing(4);
    // The previous request ended at 90 + 10 s; this one starts 6 minutes later.
    reqs.push(req({ id: 'e', at: 100 + 6 * 60, read: 0, write: 52_000, shape: 'shape-1' }));
    const [b] = agentCacheBreaks(reqs);
    expect(b?.reason).toBe('expired');
    expect(b?.idleMs).toBe(6 * 60_000);
    expect(b?.ttlMs).toBe(5 * 60_000);
  });

  it('gives a previous request that wrote to the hour-long cache an hour', () => {
    const reqs = growing(3);
    reqs.push(
      req({ id: 'p', at: 90, read: 48_000, write: 3_994, write1h: 3_994, shape: 'shape-1' }),
    );
    reqs.push(req({ id: 'x', at: 100 + 20 * 60, read: 0, write: 56_000, shape: 'shape-1' }));
    expect(agentCacheBreaks(reqs)[0]?.reason).toBe('unknown');
    reqs.push(req({ id: 'y', at: 2_000 + 61 * 60, read: 0, write: 60_000, shape: 'shape-1' }));
    // 'y' follows 'x', whose writes were five-minute ones.
    expect(agentCacheBreaks(reqs).map((b) => b.reason)).toEqual(['unknown', 'expired']);
  });

  it('says rewound when the context shrank without a compaction', () => {
    const reqs = growing(5);
    // The previous context was 56K; this one carries 30K, of which 20K was still cached.
    reqs.push(req({ id: 'r', at: 150, read: 20_000, write: 10_000, shape: 'shape-1' }));
    expect(agentCacheBreaks(reqs).map((b) => [b.request.id, b.reason])).toEqual([['r', 'rewound']]);
  });

  it('says unknown when nothing explains it', () => {
    const reqs = growing(4);
    reqs.push(req({ id: 'u', at: 120, read: 2_000, write: 50_000, shape: 'shape-1' }));
    expect(agentCacheBreaks(reqs)[0]?.reason).toBe('unknown');
  });

  it('ignores a small context: under 20K a miss costs little', () => {
    const reqs = [
      req({ id: 'a', at: 0, read: 0, write: 12_000 }),
      req({ id: 'b', at: 30, read: 0, write: 14_000 }),
    ];
    expect(agentCacheBreaks(reqs)).toEqual([]);
  });

  it('needs reads under half the previous context', () => {
    const reqs = growing(4);
    // Previous context 52K: reading 27K of it is not a break, 25K is.
    const ok = req({ id: 'ok', at: 120, read: 27_000, write: 29_000, shape: 'shape-1' });
    expect(agentCacheBreaks([...reqs, ok])).toEqual([]);
    const miss = req({ id: 'miss', at: 120, read: 25_000, write: 31_000, shape: 'shape-1' });
    expect(agentCacheBreaks([...reqs, miss])).toHaveLength(1);
  });

  it('estimates the tokens written again less the median turn’s own writes', () => {
    const reqs = growing(1);
    // Non-break writes after the first request: 2K, 3K, 9K → median 3K.
    let context = 40_000;
    for (const [i, write] of [2_000, 3_000, 9_000].entries()) {
      reqs.push(req({ id: `n${i}`, at: 30 * (i + 1), read: context, write: write - 6 }));
      context += write;
    }
    reqs.push(req({ id: 'b', at: 120, read: 0, write: 60_000 - 6 }));
    const [b] = agentCacheBreaks(reqs);
    expect(b?.rewritten).toBe(60_000 - 3_000);
  });

  it('writes again no fewer than none', () => {
    const reqs = growing(4);
    reqs.push(req({ id: 'r', at: 150, read: 1_000, write: 500, input: 0, shape: 'shape-1' }));
    expect(agentCacheBreaks(reqs)[0]?.rewritten).toBe(0);
  });

  it('reads the requests in time order, whatever order they come in', () => {
    const reqs = growing(4);
    reqs.push(req({ id: 's', at: 120, read: 0, write: 52_000, shape: 'shape-2' }));
    expect(agentCacheBreaks([...reqs].reverse()).map((b) => b.request.id)).toEqual(['s']);
  });

  it('skips requests without usage: in flight, or failed', () => {
    const reqs = growing(4);
    const flying = { ...req({ id: 'f', at: 110, read: 0, write: 0 }), usage: null };
    reqs.push(flying);
    expect(agentCacheBreaks(reqs)).toEqual([]);
  });
});

describe('cacheBreaks', () => {
  it('looks at each agent on its own, the given ones only', () => {
    const main = growing(4);
    const sub = growing(4, 0, 'sub');
    sub.push(req({ id: 'sb', agentId: 'sub', at: 120, read: 0, write: 52_000, shape: 'shape-9' }));
    const all = cacheBreaks(input([...main, ...sub]));
    expect(all.available && all.breaks.map((b) => b.request.id)).toEqual(['sb']);
    const mainOnly = cacheBreaks(input([...main, ...sub]), new Set(['main']));
    expect(mainOnly.available && mainOnly.breaks).toEqual([]);
  });

  it('is not available without any cache figures', () => {
    const plain = [
      req({ id: 'a', at: 0, read: 0, write: 0, input: 30_000 }),
      req({ id: 'b', at: 30, read: 0, write: 0, input: 34_000 }),
    ];
    expect(cacheBreaks(input(plain))).toEqual({ available: false });
  });

  it('is not available when the agent reports no usage per request', () => {
    expect(cacheBreaks(input(growing(4), ['per-request-usage']))).toEqual({ available: false });
  });

  it('lists the breaks of every agent in time order', () => {
    const main = growing(4);
    main.push(req({ id: 'm', at: 300, read: 0, write: 52_000, shape: 'shape-2' }));
    const sub = growing(4, 0, 'sub');
    sub.push(req({ id: 's', agentId: 'sub', at: 200, read: 0, write: 52_000, shape: 'shape-2' }));
    const r = cacheBreaks(input([...main, ...sub]));
    expect(r.available && r.breaks.map((b) => b.request.id)).toEqual(['s', 'm']);
  });

  it('keys the breaks by request for the execution chain', () => {
    const reqs = growing(4);
    reqs.push(req({ id: 's', at: 120, read: 0, write: 52_000, shape: 'shape-2' }));
    expect([...cacheBreaksById(input(reqs), 'main').keys()]).toEqual(['s']);
    expect(cacheBreaksById(input(reqs, ['per-request-usage']), 'main').size).toBe(0);
  });
});

describe('cacheBreakCost', () => {
  it('prices the tokens written again at the cache-write price', () => {
    const reqs = growing(1);
    reqs.push(req({ id: 'b', at: 30, read: 0, write: 1_000_000 - 6 }));
    const breaks = agentCacheBreaks(reqs);
    // No non-break request beyond the first: nothing to take off, 1M tokens written again.
    expect(breaks[0]?.rewritten).toBe(1_000_000);
    const cost = cacheBreakCost(breaks, DEFAULT_PRICES);
    // Opus 5.5: $5 per million five-minute cache writes, $4 per million uncached input.
    expect(cost.priced).toBe(true);
    expect(cost.usd).toBeCloseTo(5 * (999_994 / 1_000_000) + 4 * (6 / 1_000_000), 6);
  });

  it('has no figure for a model without a price', () => {
    const reqs: ModelRequest[] = growing(1).map((r) => ({ ...r, model: 'gpt-5.5-codex' }));
    reqs.push(req({ id: 'b', at: 30, read: 0, write: 60_000, model: 'gpt-5.5-codex' }));
    const cost = cacheBreakCost(agentCacheBreaks(reqs), DEFAULT_PRICES);
    expect(cost.priced).toBe(false);
    expect(cost.partial).toBe(true);
  });
});

describe('the demo', () => {
  it('breaks the cache once for each reason, the first request of no agent among them', () => {
    const snap = stageCacheBreaks(createDemoSnapshot(DEMO_NOW));
    const open = fromSnapshot(snap.session.id, snap);
    const found = cacheBreaks(open);
    expect(found.available && found.breaks.map((b) => [b.request.id, b.reason])).toEqual([
      ['req_m2', 'shape'],
      ['req_w2_4', 'compaction'],
      ['req_w2_7', 'rewound'],
      ['req_w3_2', 'unknown'],
      ['req_w1_4', 'expired'],
    ]);
  });

  it('serves the fixture itself unchanged to everything else', () => {
    const plain = fromSnapshot('demo', createDemoSnapshot(DEMO_NOW));
    const found = cacheBreaks(plain);
    expect(found.available && found.breaks).toEqual([]);
  });
});
