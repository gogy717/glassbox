import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunState } from '../../../src/shared/runs.js';
import { testRun } from '../test/demo';
import { approvalsFor, useApprovals } from './approvals';

const T = (s: number) => new Date(Date.UTC(2026, 9, 23, 10, 0, s)).toISOString();
const ask = (id: string, at: string) => ({
  id,
  toolName: 'Bash',
  input: {},
  questions: null,
  requestedAt: at,
});

function runs(): Map<string, RunState> {
  return new Map([
    [
      'r1',
      testRun({
        id: 'r1',
        status: 'closed',
        decidedPermissions: [
          { id: 'tu_a', toolName: 'Bash', requestedAt: T(0), decidedAt: T(5), decision: 'allow' },
          {
            id: 'tu_bad',
            toolName: 'Bash',
            requestedAt: 'nope',
            decidedAt: T(5),
            decision: 'deny',
          },
        ],
      }),
    ],
    ['r2', testRun({ id: 'r2', pendingPermissions: [ask('tu_b', T(60))] })],
    ['r3', testRun({ id: 'r3', sessionId: 'other', pendingPermissions: [ask('tu_c', T(1))] })],
  ]);
}

describe('approvalsFor', () => {
  it('collects answered and open prompts from every run of the session, closed ones too', () => {
    expect([...approvalsFor(runs(), testRun({}).sessionId)]).toEqual([
      ['tu_a', { requestedAt: Date.parse(T(0)), decidedAt: Date.parse(T(5)) }],
      ['tu_b', { requestedAt: Date.parse(T(60)), decidedAt: null }],
    ]);
  });

  it('is empty without a session, and copes with runs that keep no history', () => {
    expect(approvalsFor(runs(), null).size).toBe(0);
    const noHistory = new Map([['r', testRun({ pendingPermissions: [ask('tu_x', T(2))] })]]);
    expect([...approvalsFor(noHistory, testRun({}).sessionId).keys()]).toEqual(['tu_x']);
  });
});

describe('useApprovals', () => {
  it('keeps its identity while the windows stay the same, e.g. as a reply streams', () => {
    const sid = testRun({}).sessionId;
    const { result, rerender } = renderHook(({ r }) => useApprovals(r, sid), {
      initialProps: { r: runs() },
    });
    const first = result.current;
    rerender({ r: runs() });
    expect(result.current).toBe(first);
  });
});
