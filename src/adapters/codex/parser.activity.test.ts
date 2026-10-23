import { describe, expect, it } from 'vitest';
import { at, gardenSession } from './__fixtures__/builders.js';
import { feed } from './__fixtures__/harness.js';

/** The garden session up to and including line `n` (0-based), with the process running. */
const upTo = (n: number) => feed(gardenSession().slice(0, n + 1), [], 'busy');

describe('activity of a live Codex session', () => {
  it('follows a turn: the reply so far, the tool, the next step', () => {
    // Reasoning and a commentary message are out; the response has no usage yet.
    expect(upTo(9).snapshot().session.activity).toEqual({
      kind: 'writing',
      tool: null,
      target: null,
      agentId: 'main',
      since: at(3),
    });
    expect(upTo(10).snapshot().session.activity).toEqual({
      kind: 'tool',
      tool: 'exec',
      target: 'ls beds',
      agentId: 'main',
      since: at(5),
    });
    // The output is in and the first response is answered: the model is on its next step.
    expect(upTo(13).snapshot().session.activity).toMatchObject({ kind: 'thinking', since: at(7) });
  });

  it('says nothing once the turn is complete but the process still looks busy', () => {
    expect('activity' in upTo(18).snapshot().session).toBe(false);
  });

  it('is idle since the turn ended, and absent once closed', () => {
    const p = upTo(18);
    p.setLive('idle');
    expect(p.snapshot().session.activity).toMatchObject({ kind: 'idle', since: at(11) });
    p.setLive('closed');
    expect('activity' in p.snapshot().session).toBe(false);
  });
});
