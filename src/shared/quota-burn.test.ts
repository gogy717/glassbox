import { describe, expect, it } from 'vitest';
import type { QuotaSnapshot, QuotaWindow } from '../core/model.js';
import { emptyUsage } from '../core/usage.js';
import {
  BURN_FALLBACK_MS,
  type BurnSession,
  burnSince,
  burnTokens,
  burnWindow,
  mayUse,
  requestProvider,
  topBurn,
  windowStart,
} from './quota-burn.js';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

const win = (o: Partial<QuotaWindow> = {}): QuotaWindow => ({
  id: 'five_hour',
  kind: 'session',
  label: null,
  model: null,
  usedPercent: 40,
  resetsAt: iso(NOW + 2 * HOUR),
  ...o,
});

const snap = (windows: QuotaWindow[]): QuotaSnapshot => ({
  provider: 'anthropic',
  agent: 'claude-code',
  plan: 'Max',
  fetchedAt: iso(NOW - 60_000),
  stale: false,
  windows,
  extraUsage: null,
  balance: null,
  source: 'claude-code-cache',
});

describe("the window's start", () => {
  it('is its reset time less its length: 5 hours for a session window', () => {
    expect(windowStart(win(), NOW)).toBe(NOW - 3 * HOUR);
  });

  it('takes the length its source states over its kind', () => {
    expect(windowStart(win({ durationMs: 4 * HOUR }), NOW)).toBe(NOW - 2 * HOUR);
  });

  it('is a week before the reset for a weekly window', () => {
    const w = win({ id: 'seven_day', kind: 'weekly', resetsAt: iso(NOW + 24 * HOUR) });
    expect(windowStart(w, NOW)).toBe(NOW - 6 * 24 * HOUR);
  });

  it('is unknown without a reset time, for a window of no known length, or one past its reset', () => {
    expect(windowStart(win({ resetsAt: null }), NOW)).toBeNull();
    expect(windowStart(win({ kind: 'other' }), NOW)).toBeNull();
    expect(windowStart(win({ resetsAt: iso(NOW - 1) }), NOW)).toBeNull();
  });
});

describe('the window a burn covers', () => {
  it('is the 5-hour window when there is one, though another is closer to its limit', () => {
    const weekly = win({ id: 'seven_day', kind: 'weekly', usedPercent: 90 });
    expect(burnWindow(snap([weekly, win()]), NOW)?.id).toBe('five_hour');
  });

  it('is else the current window closest to its limit', () => {
    const a = win({ id: 'a', kind: 'weekly', usedPercent: 20 });
    const b = win({ id: 'b', kind: 'weekly', usedPercent: 60 });
    const past = win({ id: 'c', kind: 'weekly', usedPercent: 99, resetsAt: iso(NOW - 1) });
    expect(burnWindow(snap([a, b, past]), NOW)?.id).toBe('b');
  });

  it('starts at the window’s start, and with no window known, 5 hours ago', () => {
    expect(burnSince(snap([win()]), NOW)).toBe(NOW - 3 * HOUR);
    expect(burnSince(snap([]), NOW)).toBe(NOW - BURN_FALLBACK_MS);
    expect(burnSince(null, NOW)).toBe(NOW - 5 * HOUR);
    expect(burnSince(snap([win({ resetsAt: null })]), NOW)).toBe(NOW - 5 * HOUR);
  });
});

describe('which requests count against a provider', () => {
  it('counts every request of a CLI that talks to one provider for that provider only', () => {
    expect(requestProvider('claude-code', 'gpt-5')).toBe('anthropic');
    expect(requestProvider('codex', null)).toBe('openai');
    expect(requestProvider('grok', 'grok-4')).toBe('xai');
    expect(mayUse('claude-code', 'anthropic')).toBe(true);
    expect(mayUse('claude-code', 'openai')).toBe(false);
    expect(mayUse('codex', 'anthropic')).toBe(false);
  });

  it('places a request of a CLI that talks to any provider by its model', () => {
    expect(mayUse('oh-my-pi', 'anthropic')).toBe(true);
    expect(requestProvider('oh-my-pi', 'claude-sonnet-4-5')).toBe('anthropic');
    expect(requestProvider('opencode', 'anthropic/claude-opus-4-1')).toBe('anthropic');
    expect(requestProvider('oh-my-pi', 'grok-code-fast-1')).toBe('xai');
    expect(requestProvider('opencode', 'openai/gpt-5-codex')).toBe('openai');
    expect(requestProvider('opencode', 'deepseek-chat')).toBe('deepseek');
    expect(requestProvider('oh-my-pi', 'github-copilot/claude-sonnet-4')).toBe('github-copilot');
    expect(requestProvider('oh-my-pi', 'llama-3')).toBeNull();
    expect(requestProvider('oh-my-pi', null)).toBeNull();
  });
});

const row = (id: string, tokens: number, share: number): BurnSession => ({
  id,
  agent: 'claude-code',
  project: 'demo',
  cwd: null,
  title: id,
  usage: { ...emptyUsage(), input: tokens },
  requests: 1,
  tokens,
  share,
});

describe('the top of the list', () => {
  it('keeps the first n and folds the rest into "more", the shares adding up to 1', () => {
    const tokens = [50, 20, 10, 8, 5, 4, 3];
    const total = tokens.reduce((a, b) => a + b, 0);
    const rows = tokens.map((n, i) => row(`s${i}`, n, n / total));
    const { top, more } = topBurn(rows, 5);
    expect(top.map((r) => r.id)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(more).toEqual({ count: 2, tokens: 7, share: 7 / total });
    const sum = top.reduce((a, r) => a + r.share, 0) + more.share;
    expect(sum).toBeCloseTo(1, 10);
  });

  it('has nothing more when the list is short', () => {
    expect(topBurn([row('a', 3, 1)], 5).more).toEqual({ count: 0, tokens: 0, share: 0 });
  });

  it('counts every kind of token, thinking being part of output', () => {
    const u = {
      ...emptyUsage(),
      input: 1,
      cacheRead: 10,
      cacheWrite: 100,
      output: 1000,
      thinking: 500,
    };
    expect(burnTokens(u)).toBe(1111);
  });
});
