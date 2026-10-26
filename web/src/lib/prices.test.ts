import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '../../../src/core/model.js';
import { emptyUsage } from '../../../src/core/usage.js';
import {
  costByModel,
  costOf,
  DEFAULT_PRICES,
  formatUsd,
  formatUsdShort,
  type PriceTable,
  priceOf,
  priceTable,
  sumCost,
} from './prices';

const M = 1_000_000;
const usage = (over: Partial<TokenUsage>): TokenUsage => ({ ...emptyUsage(), ...over });

/** Round numbers, so every cost below can be worked out by hand. */
const TABLE: PriceTable = {
  'model-a': {
    input: 10,
    cacheWrite: 12.5,
    cacheWrite1h: 20,
    cacheRead: 1,
    output: 50,
    asOf: null,
  },
  'model-a-mini': { input: 1, cacheWrite: 1, cacheWrite1h: 1, cacheRead: 1, output: 1, asOf: null },
};

describe('costOf', () => {
  it('prices each kind of token at its rate per million', () => {
    const u = usage({
      input: 2 * M,
      cacheRead: 10 * M,
      cacheWrite: 3 * M,
      cacheWrite5m: 1 * M,
      cacheWrite1h: 2 * M,
      output: 1 * M,
    });
    // 2 × 10 + 10 × 1 + 1 × 12.5 + 2 × 20 + 1 × 50
    expect(costOf(u, 'model-a', TABLE)).toBe(132.5);
  });

  it('prices cache writes of unknown duration as 5-minute writes', () => {
    expect(costOf(usage({ cacheWrite: 2 * M }), 'model-a', TABLE)).toBe(25);
    expect(costOf(usage({ cacheWrite: 3 * M, cacheWrite1h: 1 * M }), 'model-a', TABLE)).toBe(
      2 * 12.5 + 20,
    );
  });

  it('leaves thinking and web tool counts out: thinking is in output already', () => {
    const u = usage({ output: M, thinking: M, webSearch: 9, webFetch: 9 });
    expect(costOf(u, 'model-a', TABLE)).toBe(50);
  });

  it('costs nothing without usage, and has no price for a model without an entry or none', () => {
    expect(costOf(null, 'model-a', TABLE)).toBe(0);
    expect(costOf(usage({ output: M }), 'model-b', TABLE)).toBeNull();
    expect(costOf(usage({ output: M }), null, TABLE)).toBeNull();
  });
});

describe('priceOf', () => {
  it('matches a model by its id, its dated snapshots and the forms clouds and tools give it', () => {
    for (const id of [
      'model-a',
      'model-a-20251101',
      'model-a@20251101',
      'anthropic.model-a-20251101-v1:0',
      'us.anthropic.model-a-v1:0',
      'anthropic/model-a',
      'model-a[1m]',
      'MODEL-A',
    ])
      expect(priceOf(id, TABLE)?.input, id).toBe(10);
    expect(priceOf('model-a-mini-20260101', TABLE)?.input).toBe(1);
  });

  it('takes the most specific entry: a snapshot priced on its own wins over its model', () => {
    const table = { ...TABLE, 'model-a-20251101': { ...TABLE['model-a'], input: 7 } } as PriceTable;
    expect(priceOf('model-a-20251101', table)?.input).toBe(7);
    expect(priceOf('model-a-20251101-v1:0', table)?.input).toBe(7);
    expect(priceOf('model-a-20260101', table)?.input).toBe(10);
  });

  it('never takes a newer model for an older one whose id begins its own', () => {
    expect(priceOf('model-a-5', TABLE)).toBeNull();
    expect(priceOf('model-ab', TABLE)).toBeNull();
    expect(priceOf('claude-opus-5-6', DEFAULT_PRICES)).toBeNull();
    expect(priceOf('claude-opus-4-9', DEFAULT_PRICES)).toBeNull();
    expect(priceOf('claude-opus-5-5', DEFAULT_PRICES)?.input).toBe(4);
    expect(priceOf('claude-opus-5', DEFAULT_PRICES)?.input).toBe(5);
    expect(priceOf('claude-opus-4-20250514', DEFAULT_PRICES)?.input).toBe(15);
    expect(priceOf('<synthetic>', DEFAULT_PRICES)).toBeNull();
    expect(priceOf(null, DEFAULT_PRICES)).toBeNull();
  });
});

describe('DEFAULT_PRICES', () => {
  it('has Anthropic’s list prices of 26 October 2026 for the Claude models', () => {
    expect(DEFAULT_PRICES['claude-fable-5-1']).toEqual({
      input: 10,
      cacheWrite: 12.5,
      cacheWrite1h: 20,
      cacheRead: 0.25,
      output: 50,
      asOf: '2026-10-26',
    });
    expect(DEFAULT_PRICES['claude-opus-5-5']).toMatchObject({ input: 4, cacheRead: 0.2 });
    expect(DEFAULT_PRICES['claude-sonnet-5-5']).toMatchObject({ input: 2, cacheRead: 0.1 });
    expect(DEFAULT_PRICES['claude-haiku-5-5']).toMatchObject({ input: 0.1, output: 0.5 });
    for (const [model, p] of Object.entries(DEFAULT_PRICES)) {
      expect(model).toMatch(/^claude-/);
      expect(p.asOf, model).toBe('2026-10-26');
      // 5-minute writes at 1.25× input and 1-hour writes at 2×, on every model.
      expect(p.cacheWrite, model).toBeCloseTo(p.input * 1.25, 9);
      expect(p.cacheWrite1h, model).toBeCloseTo(p.input * 2, 9);
    }
  });
});

describe('priceTable', () => {
  it('lays the person’s prices over the defaults, by model id, and can add a model', () => {
    const own = { input: 1, cacheWrite: 2, cacheWrite1h: 3, cacheRead: 4, output: 5 };
    const table = priceTable({ 'claude-opus-5-5': own, 'gpt-x': own });
    expect(table['claude-opus-5-5']).toEqual({ ...own, asOf: null });
    expect(table['gpt-x']).toEqual({ ...own, asOf: null });
    expect(table['claude-sonnet-5-5']).toBe(DEFAULT_PRICES['claude-sonnet-5-5']);
    expect(priceTable({})).toEqual(DEFAULT_PRICES);
  });
});

describe('sumCost', () => {
  it('adds the priced calls up and names the models without a price', () => {
    const cost = sumCost(
      [
        { model: 'model-a', usage: usage({ output: M }) },
        { model: 'model-a', usage: null },
        { model: 'model-b', usage: usage({ input: M }) },
        { model: 'model-c', usage: usage({ input: M }) },
        { model: 'model-b', usage: usage({ input: M }) },
        // A call that used nothing has nothing to price: it is not "without a price".
        { model: '<synthetic>', usage: usage({}) },
      ],
      TABLE,
    );
    expect(cost).toEqual({
      usd: 50,
      priced: true,
      partial: true,
      unpriced: ['model-b', 'model-c'],
    });
  });

  it('has no figure when no call was priced, and is whole when every one was', () => {
    expect(sumCost([{ model: null, usage: usage({ input: M }) }], TABLE)).toEqual({
      usd: 0,
      priced: false,
      partial: true,
      unpriced: [],
    });
    expect(sumCost([], TABLE)).toEqual({ usd: 0, priced: false, partial: false, unpriced: [] });
    expect(sumCost([{ model: 'model-a', usage: usage({ input: M }) }], TABLE)).toMatchObject({
      usd: 10,
      priced: true,
      partial: false,
    });
  });
});

describe('costByModel', () => {
  it('prices usage already added up by model, the calls of no model under ""', () => {
    expect(
      costByModel({ 'model-a': usage({ output: M }), '': usage({ input: M }) }, TABLE),
    ).toEqual({ usd: 50, priced: true, partial: true, unpriced: [] });
  });
});

describe('formatUsd', () => {
  it('writes dollars to the cent, and short for a row: cents under $10, whole dollars above', () => {
    expect(formatUsd(412.3, 'en')).toBe('$412.30');
    expect(formatUsd(1234.567, 'zh-CN')).toBe('$1,234.57');
    expect(formatUsdShort(0.834, 'en')).toBe('$0.83');
    expect(formatUsdShort(9.994, 'en')).toBe('$9.99');
    expect(formatUsdShort(12.4, 'en')).toBe('$12');
    expect(formatUsdShort(1234.5, 'zh-CN')).toBe('$1,235');
    expect(formatUsdShort(0.004, 'en')).toBe('<$0.01');
    expect(formatUsdShort(0, 'en')).toBe('$0.00');
  });
});
