import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/core/model.js';
import { CHARS_PER_TOKEN } from '../../../src/shared/context-bill.js';
import { mcpUsage } from './mcp-usage';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

let serial = 0;
function call(name: string, over: Partial<ToolCall> & { at?: number; ms?: number } = {}): ToolCall {
  const { at = serial, ms = 1000, ...rest } = over;
  serial += 1;
  return {
    id: `t${serial}`,
    agentId: 'main',
    requestId: 'r1',
    name,
    input: {},
    status: 'complete',
    startedAt: iso(at),
    endedAt: iso(at + ms / 1000),
    durationMs: ms,
    resultPreview: 'ok',
    hasFullResult: true,
    spawned: null,
    resultChars: 2,
    ...rest,
  };
}

describe('mcpUsage', () => {
  it('reads both MCP name shapes: mcp__server__tool, and server__tool as Grok names them', () => {
    const servers = mcpUsage([
      call('mcp__tracker__list_issues'),
      call('tracker__get_issue'),
      call('mcp__claude_ai_Docs__search'),
      call('Read'),
      call('ListMcpResourcesTool'),
    ]);
    expect(servers.map((s) => [s.server, s.tools.map((t) => t.name)])).toEqual([
      ['tracker', ['get_issue', 'list_issues']],
      ['claude_ai_Docs', ['search']],
    ]);
  });

  it('adds a server’s figures up over its tools', () => {
    const [tracker] = mcpUsage([
      call('mcp__tracker__list_issues', { ms: 400, resultChars: 4_000 }),
      call('mcp__tracker__list_issues', { ms: 600, resultChars: 2_000 }),
      call('mcp__tracker__get_issue', {
        ms: 2_000,
        status: 'error',
        resultPreview: 'not found',
        resultChars: 9,
      }),
      call('mcp__tracker__create_issue', {
        status: 'running',
        endedAt: null,
        durationMs: null,
        resultPreview: null,
        resultChars: undefined,
      }),
    ]);
    if (!tracker) throw new Error('no server');
    const sum = (k: 'failures' | 'running' | 'ms' | 'resultChars') =>
      tracker.tools.reduce((n, t) => n + t[k], 0);
    expect(tracker.calls).toBe(4);
    expect(tracker.tools.reduce((n, t) => n + t.calls.length, 0)).toBe(tracker.calls);
    expect(tracker.failures).toBe(1);
    expect(sum('failures')).toBe(tracker.failures);
    expect(tracker.running).toBe(1);
    expect(sum('running')).toBe(tracker.running);
    // A running call has no time yet: the finished ones add up, and the median is theirs.
    expect(tracker.ms).toBe(3_000);
    expect(sum('ms')).toBe(tracker.ms);
    expect(tracker.medianMs).toBe(600);
    expect(tracker.resultChars).toBe(6_009);
    expect(sum('resultChars')).toBe(tracker.resultChars);
    expect(tracker.tokens).toBe(Math.round(6_009 / CHARS_PER_TOKEN));
    // Tools by calls, most first; each tool's calls in the order they started.
    expect(tracker.tools.map((t) => [t.name, t.calls.length])).toEqual([
      ['list_issues', 2],
      ['create_issue', 1],
      ['get_issue', 1],
    ]);
  });

  it('orders servers by calls, a tool’s calls by start, and takes the median of an even count', () => {
    const servers = mcpUsage([
      call('mcp__docs__search', { at: 50, ms: 100 }),
      call('mcp__tracker__get_issue', { at: 1 }),
      call('mcp__docs__search', { at: 10, ms: 300 }),
    ]);
    expect(servers.map((s) => [s.server, s.calls])).toEqual([
      ['docs', 2],
      ['tracker', 1],
    ]);
    expect(servers[0]?.tools[0]?.calls.map((c) => c.startedAt)).toEqual([iso(10), iso(50)]);
    expect(servers[0]?.medianMs).toBe(200);
  });

  it('times a call by its ends when it records no duration, sizes it by its preview when it records no size', () => {
    const [docs] = mcpUsage([
      call('mcp__docs__fetch', {
        at: 0,
        durationMs: null,
        endedAt: iso(2.5),
        resultChars: undefined,
        resultPreview: 'twelve chars',
      }),
    ]);
    expect(docs?.ms).toBe(2_500);
    expect(docs?.resultChars).toBe(12);
  });

  it('counts only the agents asked for', () => {
    const calls = [
      call('mcp__docs__search'),
      call('mcp__docs__search', { agentId: 'sub1' }),
      call('mcp__tracker__get_issue', { agentId: 'sub2' }),
    ];
    expect(mcpUsage(calls).map((s) => [s.server, s.calls])).toEqual([
      ['docs', 2],
      ['tracker', 1],
    ]);
    expect(mcpUsage(calls, new Set(['main', 'sub1'])).map((s) => [s.server, s.calls])).toEqual([
      ['docs', 2],
    ]);
    expect(mcpUsage(calls, new Set(['other']))).toEqual([]);
  });
});
