import { describe, expect, it } from 'vitest';
import {
  hourTotal,
  lastMinute,
  MINUTE_MS,
  RATE_MINUTES,
  rateAgents,
  rateCoverage,
  ratePerMinute,
  rateSeries,
  type TokenRate,
} from './rate.js';

const MINUTE = Date.UTC(2026, 9, 24, 10, 59, 0);
const flat = (n: number) => new Array<number>(RATE_MINUTES).fill(n);
/** The last values of a series, the rest zero. */
const tail = (...values: number[]) => [
  ...new Array<number>(RATE_MINUTES - values.length).fill(0),
  ...values,
];

const rate = (o: Partial<TokenRate> = {}): TokenRate => ({
  minute: new Date(MINUTE).toISOString(),
  at: new Date(MINUTE + 30_000).toISOString(),
  since: new Date(MINUTE - 120 * MINUTE_MS).toISOString(),
  agents: {
    'claude-code': {
      input: tail(10, 10, 10, 10, 10),
      cacheRead: tail(800, 900, 1000, 1100, 600),
      cacheWrite: flat(0),
      output: tail(40, 40, 40, 40, 20),
    },
    codex: {
      input: flat(0),
      cacheRead: tail(100, 0, 0, 0, 100),
      cacheWrite: flat(0),
      output: flat(0),
    },
  },
  coverage: {
    running: 3,
    counted: 2,
    agents: { 'claude-code': { running: 2, counted: 2 }, codex: { running: 1, counted: 0 } },
  },
  ...o,
});

describe('rate helpers', () => {
  it('sums a scope per minute: all agents, one agent, one kind', () => {
    expect(rateSeries(rate()).slice(-5)).toEqual([950, 950, 1050, 1150, 730]);
    expect(rateSeries(rate(), { agent: 'codex' }).slice(-5)).toEqual([100, 0, 0, 0, 100]);
    expect(rateSeries(rate(), { agent: 'claude-code', kind: 'output' }).slice(-5)).toEqual([
      40, 40, 40, 40, 20,
    ]);
    expect(rateSeries(rate(), { agent: 'grok' }).every((n) => n === 0)).toBe(true);
  });

  it('averages the last five buckets over the time they cover, the newest one partial', () => {
    // 4,830 tokens over 4.5 minutes (four whole buckets and half of the current one).
    expect(ratePerMinute(rate())).toBeCloseTo(4830 / 4.5);
    expect(ratePerMinute(rate(), { agent: 'codex' })).toBeCloseTo(200 / 4.5);
    expect(ratePerMinute(rate(), { kind: 'cacheRead' })).toBeCloseTo(4600 / 4.5);
  });

  it('averages only the time counted since the server started, at least a minute', () => {
    // Counting began 90 s before `at`: 1,880 tokens of the two newest buckets over 1.5 minutes.
    const young = rate({ since: new Date(MINUTE + 30_000 - 90_000).toISOString() });
    expect(ratePerMinute(young)).toBeCloseTo(4830 / 1.5);
    const fresh = rate({ since: new Date(MINUTE + 25_000).toISOString() });
    expect(ratePerMinute(fresh)).toBe(4830);
  });

  it('reads the last complete minute and the hour’s total', () => {
    expect(lastMinute(rate())).toBe(1150);
    expect(hourTotal(rate())).toBe(4830);
    expect(hourTotal(rate(), { agent: 'codex' })).toBe(200);
  });

  it('says how many running sessions are counted, for all agents or one', () => {
    expect(rateCoverage(rate())).toEqual({ running: 3, counted: 2 });
    expect(rateCoverage(rate(), 'codex')).toEqual({ running: 1, counted: 0 });
    expect(rateCoverage(rate(), 'grok')).toEqual({ running: 0, counted: 0 });
  });

  it('lists the agents with anything counted', () => {
    expect(rateAgents(rate()).sort()).toEqual(['claude-code', 'codex']);
    expect(rateAgents(rate({ agents: {} }))).toEqual([]);
  });
});
