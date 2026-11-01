import { describe, expect, it } from 'vitest';
import type { ModelRequest, Turn } from '../../../src/core/model.js';
import type { OpenSession } from '../data/store';
import { DEMO_NOW, demoOpen } from '../test/demo';
import { activityStrip } from './activity';
import { summarize } from './agents';

const now = DEMO_NOW.getTime();

/** The demo with one request replaced. */
function withRequest(open: OpenSession, id: string, patch: Partial<ModelRequest>): OpenSession {
  const r = open.requests.get(id);
  if (!r) throw new Error(`no request ${id}`);
  const requests = new Map(open.requests);
  requests.set(id, { ...r, ...patch });
  return { ...open, requests };
}

describe('activityStrip', () => {
  it("places turns, calls and tools along the agent's span by their start time", () => {
    const open = demoOpen();
    const s = summarize(open, 'main', now);
    const strip = activityStrip(open, 'main', now);
    expect(strip.span).toEqual(s.span);
    expect(strip.turns).toHaveLength(s.turns);
    expect(strip.calls).toHaveLength(s.requests);
    expect(strip.tools).toHaveLength(s.toolCalls);
    for (const m of [...strip.turns, ...strip.calls, ...strip.tools]) {
      expect(m.x).toBeGreaterThanOrEqual(0);
      expect(m.x).toBeLessThanOrEqual(1);
    }
    // Calls come in start order, so their x never goes back.
    for (let i = 1; i < strip.calls.length; i++)
      expect(strip.calls[i]?.x).toBeGreaterThanOrEqual(strip.calls[i - 1]?.x ?? 0);
    expect(strip.turns[0]?.x).toBe(0);
  });

  it('scales each call by its output against the largest, hollow before usage arrives', () => {
    const open = demoOpen();
    let largest: ModelRequest | null = null;
    for (const r of open.requests.values())
      if (r.usage && (!largest?.usage || r.usage.output > largest.usage.output)) largest = r;
    if (!largest) throw new Error('the demo has usage');
    const strip = activityStrip(open, 'main', now);
    const tallest = strip.calls.filter((c) => c.h === 1);
    expect(tallest).toHaveLength(1);
    const top = tallest[0] as (typeof tallest)[number];
    expect(top.hollow).toBe(false);
    const hollow = activityStrip(withRequest(open, largest.id, { usage: null }), 'main', now);
    expect(hollow.calls.find((c) => c.x === top.x)).toEqual({
      x: top.x,
      h: 0,
      hollow: true,
    });
    // The largest gone, the next largest is now the tallest.
    expect(hollow.calls.some((c) => c.h === 1)).toBe(true);
  });

  it('draws a single running turn with no finished call at x = 0, without NaN', () => {
    const open = demoOpen();
    const turn = [...open.turns.values()].find((t) => t.agentId === 'main') as Turn;
    const request = [...open.requests.values()].find((r) => r.agentId === 'main') as ModelRequest;
    const only: OpenSession = {
      ...open,
      turns: new Map([
        [
          turn.id,
          { ...turn, startedAt: new Date(now).toISOString(), endedAt: null, status: 'running' },
        ],
      ]),
      requests: new Map([
        [
          request.id,
          { ...request, startedAt: new Date(now).toISOString(), endedAt: null, usage: null },
        ],
      ]),
      toolCalls: new Map(),
    };
    const strip = activityStrip(only, 'main', now);
    expect(strip.span).toEqual({ start: now, end: now });
    expect(strip.turns).toEqual([{ x: 0 }]);
    expect(strip.calls).toEqual([{ x: 0, h: 0, hollow: true }]);
    expect(strip.tools).toEqual([]);
  });

  it('leaves out a call that has no start time', () => {
    const open = demoOpen();
    const first = [...open.requests.values()][0] as ModelRequest;
    const strip = activityStrip(withRequest(open, first.id, { startedAt: null }), 'main', now);
    expect(strip.calls).toHaveLength(summarize(open, 'main', now).requests - 1);
  });
});
