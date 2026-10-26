import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '../../../src/core/model.js';
import { DEMO_NOW, demoOpen, pendingFor, withRunningTool } from '../test/demo';
import { buildSteps } from './steps';

const NOW = DEMO_NOW.getTime();

describe('buildSteps', () => {
  it('turns turn 1 into explore → edit (failed) → answer', () => {
    const phases = buildSteps(demoOpen(), 'main', 'turn_m1', NOW);
    expect(
      phases.map((p) => [p.category, p.steps.map((s) => s.requestId), p.durationMs, p.tokens]),
    ).toEqual([
      ['explore', ['req_m1'], 14_400, 32_070],
      ['edit', ['req_m2'], 21_820, 36_440],
      ['answer', ['req_m3'], 9_000, 38_220],
    ]);
    expect(phases[1]?.steps[0]?.outcome).toBe('error');
    expect(phases.map((p) => p.startedAt)).toEqual([
      '2026-10-23T09:20:02.000Z',
      '2026-10-23T09:20:17.000Z',
      '2026-10-23T09:20:39.000Z',
    ]);
  });

  it('records what the model thought, said and did in each step', () => {
    const [explore, edit, answer] = buildSteps(demoOpen(), 'main', 'turn_m1', NOW);
    expect(explore?.steps[0]).toMatchObject({
      index: 1,
      thought: {
        text: 'Looking for where the session list is sorted before touching the UI.',
        durationMs: 8_400,
        tokens: 610,
        hidden: false,
      },
      said: 'Let me look at how sessions are discovered first.',
      did: [
        {
          toolCallId: 'tu_m1a',
          name: 'Bash',
          category: 'explore',
          summary: 'rg -n "sortSessions" src',
          status: 'complete',
        },
      ],
      outcome: 'ok',
    });
    // Thinking blocks without text: the model thought, the content is not readable.
    expect(edit?.steps[0]?.thought).toEqual({
      text: null,
      durationMs: 12_600,
      tokens: 1_100,
      hidden: true,
    });
    expect(edit?.steps[0]?.did.map((d) => [d.name, d.category, d.summary, d.status])).toEqual([
      ['Read', 'explore', 'store.ts', 'complete'],
      ['Edit', 'edit', 'store.ts', 'error'],
      ['Read', 'explore', 'store.ts:36-65', 'complete'],
      ['Edit', 'edit', 'store.ts', 'complete'],
      ['Edit', 'edit', 'store.ts', 'complete'],
      ['Write', 'edit', 'store.test.ts', 'complete'],
      ['MultiEdit', 'edit', 'sessions.ts', 'complete'],
      ['NotebookEdit', 'edit', 'sorting.ipynb', 'complete'],
      ['Read', 'explore', 'model.ts', 'complete'],
      ['Read', 'explore', 'README.md:1-40', 'complete'],
    ]);
    expect(answer?.steps[0]).toMatchObject({
      said: 'Fixed: busy sessions now sort first, then by most recent update.',
      did: [],
    });
  });

  it('merges consecutive steps of the same kind into one phase', () => {
    const phases = buildSteps(demoOpen(), 'a1b2c3d4e5f60718', 'turn_s1', NOW);
    expect(phases.map((p) => [p.category, p.steps.length])).toEqual([
      ['explore', 3],
      ['answer', 1],
    ]);
    expect(phases[0]?.durationMs).toBe(3 * 18_300);
  });

  it('folds web lookups into exploring', () => {
    const phases = buildSteps(demoOpen(), 'af00000000000001', 'turn_w1', NOW);
    // Bash `python3 …` runs; WebFetch explores; they alternate, then the final answer.
    expect(phases.map((p) => p.category)).toEqual([
      'run',
      'explore',
      'run',
      'explore',
      'run',
      'answer',
    ]);
  });

  it('shows an in-flight step as running and times it up to now', () => {
    const [phase] = buildSteps(demoOpen(), 'main', 'turn_m3', NOW);
    expect(phase?.category).toBe('answer');
    // No usage yet: unknown (null), not 0.
    expect(phase?.steps[0]).toMatchObject({ outcome: 'running', durationMs: 83_000, tokens: null });
    expect(phase?.tokens).toBeNull();
    expect(phase?.steps[0]?.thought).toEqual({
      text: null,
      durationMs: null,
      tokens: 0,
      hidden: false,
    });
  });

  it('marks a tool waiting for the person to approve it, and its step with it', () => {
    const open = withRunningTool(demoOpen(), 'tu_m1a');
    const [first] = buildSteps(open, 'main', 'turn_m1', NOW, pendingFor('tu_m1a'));
    const step = first?.steps[0];
    expect(step?.outcome).toBe('approval');
    expect(step?.did[0]).toMatchObject({ toolCallId: 'tu_m1a', status: 'approval' });
  });

  it('marks a step failed when the request itself failed', () => {
    const open = demoOpen();
    const m3 = open.requests.get('req_m3') as ModelRequest;
    open.requests = new Map(open.requests).set('req_m3', { ...m3, status: 'error' });
    expect(buildSteps(open, 'main', 'turn_m1', NOW).at(-1)?.steps[0]?.outcome).toBe('error');
  });

  it('marks a step the user interrupted', () => {
    const open = demoOpen();
    const m3 = open.requests.get('req_m3') as ModelRequest;
    open.requests = new Map(open.requests).set('req_m3', { ...m3, status: 'interrupted' });
    expect(buildSteps(open, 'main', 'turn_m1', NOW).at(-1)?.steps[0]?.outcome).toBe('interrupted');
  });

  it('builds steps for the calls outside any turn', () => {
    const open = demoOpen();
    const m1 = open.requests.get('req_m1') as ModelRequest;
    open.requests = new Map(open.requests).set('orph', {
      ...m1,
      id: 'orph',
      turnId: null,
      toolCallIds: [],
    });
    const phases = buildSteps(open, 'main', 'outside:main', NOW);
    expect(phases.flatMap((p) => p.steps.map((s) => s.requestId))).toEqual(['orph']);
  });

  it('leaves the time of a step unknown when its request start was not recorded', () => {
    const open = demoOpen();
    const m3 = open.requests.get('req_m3') as ModelRequest;
    open.requests = new Map(open.requests).set('req_m3', { ...m3, startedAt: m3.endedAt });
    const answer = buildSteps(open, 'main', 'turn_m1', NOW).at(-1);
    expect(answer?.steps[0]?.durationMs).toBeNull();
    expect(answer?.durationMs).toBeNull();
  });

  it('returns nothing for an unknown turn', () => {
    expect(buildSteps(demoOpen(), 'main', 'nope', NOW)).toEqual([]);
  });
});
