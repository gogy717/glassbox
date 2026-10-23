import { describe, expect, it } from 'vitest';
import type { TokenUsage } from './model.js';
import { addUsage, cacheHitRate, contextSize, emptyUsage, sumUsage, totalTokens } from './usage.js';

const u = (over: Partial<TokenUsage>): TokenUsage => ({ ...emptyUsage(), ...over });

describe('usage helpers', () => {
  it('sums usage and skips nulls', () => {
    const total = sumUsage([u({ input: 1, cacheRead: 10, output: 5 }), null, u({ input: 2 })]);
    expect(total).toEqual(u({ input: 3, cacheRead: 10, output: 5 }));
  });

  it('addUsage mutates and returns the first argument', () => {
    const a = u({ thinking: 1 });
    expect(addUsage(a, u({ thinking: 2 }))).toBe(a);
    expect(a.thinking).toBe(3);
  });

  it('computes context, total and cache hit rate', () => {
    const x = u({ input: 10, cacheRead: 80, cacheWrite: 10, output: 7 });
    expect(contextSize(x)).toBe(100);
    expect(totalTokens(x)).toBe(107);
    expect(cacheHitRate(x)).toBeCloseTo(0.8);
    expect(cacheHitRate(emptyUsage())).toBe(0);
  });
});
