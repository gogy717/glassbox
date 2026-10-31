import { describe, expect, it } from 'vitest';
import type { ModelRequest, TokenUsage } from '../core/model.js';
import { emptyUsage } from '../core/usage.js';
import { contextUse, contextWindow } from './context-use.js';

const T0 = Date.UTC(2026, 9, 23, 9, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

/** A request's usage that read `tokens` of context: uncached, cache reads and cache writes. */
const read = (tokens: number): TokenUsage => ({
  ...emptyUsage(),
  input: 10,
  cacheWrite: 1_000,
  cacheRead: tokens - 1_010,
  output: 400,
});

type Req = Pick<ModelRequest, 'id' | 'agentId' | 'startedAt' | 'usage' | 'model'> & {
  compactedBefore?: boolean;
};
let serial = 0;
function req(tokens: number | null, over: Partial<Req> = {}): Req {
  serial++;
  return {
    id: `q${serial}`,
    agentId: 'main',
    startedAt: at(serial),
    model: 'claude-sonnet-5-5',
    usage: tokens === null ? null : read(tokens),
    ...over,
  };
}

describe('contextWindow', () => {
  it('is 200K for a Claude model, under whatever path or region a tool names it', () => {
    for (const id of [
      'claude-opus-5-5',
      'claude-sonnet-4-5-20250929',
      'anthropic/claude-haiku-5-5',
      'us.anthropic.claude-opus-4-1-v1:0',
    ])
      expect(contextWindow(id)).toBe(200_000);
  });

  it('is 1M for a model id that names 1M, or a Claude agent whose context went past 200K', () => {
    expect(contextWindow('claude-opus-5-5[1m]')).toBe(1_000_000);
    expect(contextWindow('claude-sonnet-4-5-1m')).toBe(1_000_000);
    expect(contextWindow('claude-fable-5-1', 205_667)).toBe(1_000_000);
    expect(contextWindow('claude-fable-5-1', 200_000)).toBe(200_000);
  });

  it('is unknown for other models and for none: no table says their window', () => {
    for (const id of ['gpt-6.1-sol', 'grok-4.7', 'gemma4:12b', '', null, undefined])
      expect(contextWindow(id)).toBeNull();
    // A model of unknown window stays unknown, however large its context got.
    expect(contextWindow('gpt-6.1-sol', 300_000)).toBeNull();
  });
});

describe('contextUse', () => {
  it('is the agent’s latest finished call: what it read, of its model’s window', () => {
    serial = 0;
    const requests = [req(40_000), req(90_000), req(171_000), req(null, { agentId: 'sub' })];
    expect(contextUse(requests, 'main')).toEqual({
      agentId: 'main',
      requestId: 'q3',
      tokens: 171_000,
      window: 200_000,
    });
  });

  it('looks past a call in flight, and reads the latest by start, not by order given', () => {
    serial = 0;
    const late = req(120_000, { startedAt: at(50) });
    const requests = [late, req(150_000, { startedAt: at(10) }), req(null)];
    expect(contextUse(requests, 'main')).toMatchObject({ requestId: late.id, tokens: 120_000 });
  });

  it('has no window for a model of unknown window, and no figure for an agent with none', () => {
    serial = 0;
    expect(contextUse([req(150_000, { model: 'gpt-6.1-sol' })], 'main')).toMatchObject({
      tokens: 150_000,
      window: null,
    });
    expect(contextUse([req(null), req(0)], 'main')).toBeNull();
    expect(contextUse([req(50_000)], 'sub')).toBeNull();
  });

  it('reads a 1M window once the agent’s context went past 200K, compacted since or not', () => {
    serial = 0;
    const requests = [req(240_000), req(30_000, { compactedBefore: true }), req(60_000)];
    expect(contextUse(requests, 'main')).toMatchObject({ tokens: 60_000, window: 1_000_000 });
  });

  it('knows no figure while the call after a compaction is in flight: the old one is gone', () => {
    serial = 0;
    const requests = [req(180_000), req(null, { compactedBefore: true })];
    expect(contextUse(requests, 'main')).toBeNull();
  });
});
