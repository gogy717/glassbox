import { describe, expect, it } from 'vitest';
import type { ToolCall, Turn } from '../core/model.js';
import type { RunState } from './runs.js';
import {
  type ApprovalWindow,
  approvalsOf,
  liveSpansOf,
  turnWaitsOf,
  waitMs,
  waitsOf,
} from './waiting.js';

const at = (min: number, sec = 0) => Date.UTC(2026, 10, 1, 10, min, sec);
const iso = (t: number) => new Date(t).toISOString();

const tool = (over: Partial<ToolCall> & { name: string }): ToolCall => ({
  id: 't1',
  agentId: 'main',
  requestId: 'r1',
  input: {},
  status: 'complete',
  startedAt: iso(at(0)),
  endedAt: iso(at(0, 10)),
  durationMs: null,
  resultPreview: null,
  hasFullResult: false,
  spawned: null,
  ...over,
});

const window = (requestedAt: number, decidedAt: number | null): Map<string, ApprovalWindow> =>
  new Map([['t1', { requestedAt, decidedAt }]]);

describe('waits of a tool call', () => {
  it('counts a permission prompt answered after 3 min as 3 min of permission', () => {
    const t = tool({ name: 'Bash', endedAt: iso(at(3, 5)) });
    const waits = waitsOf([t], at(10), window(at(0), at(3)));
    expect(waits).toEqual([
      { kind: 'permission', agentId: 'main', of: 't1', start: at(0), end: at(3) },
    ]);
    expect(waitMs(waits)).toBe(3 * 60_000);
  });

  it('counts a prompt still open up to now, on a running tool', () => {
    const t = tool({ name: 'Bash', status: 'running', endedAt: null });
    expect(waitMs(waitsOf([t], at(2), window(at(0), null)))).toBe(2 * 60_000);
  });

  it('counts only the part of a prompt inside its tool call', () => {
    // The prompt was shown before the call started (a retry of the same id): cut to its span.
    const t = tool({ name: 'Bash', startedAt: iso(at(1)), endedAt: iso(at(2)) });
    expect(waitMs(waitsOf([t], at(10), window(at(0), at(5))))).toBe(60_000);
  });

  it('counts nothing for an open prompt on a tool that already ended', () => {
    const t = tool({ name: 'Bash' });
    expect(waitsOf([t], at(10), window(at(0), null))).toEqual([]);
  });

  it('counts the whole time a question was open as a question', () => {
    const t = tool({ name: 'AskUserQuestion', endedAt: iso(at(4)) });
    expect(waitsOf([t], at(10))).toEqual([
      { kind: 'question', agentId: 'main', of: 't1', start: at(0), end: at(4) },
    ]);
  });

  it('counts an approval of a plan (ExitPlanMode) as a plan wait', () => {
    const t = tool({ name: 'ExitPlanMode', endedAt: iso(at(7)) });
    expect(waitsOf([t], at(10))).toEqual([
      { kind: 'plan', agentId: 'main', of: 't1', start: at(0), end: at(7) },
    ]);
  });

  it('counts a question still open up to now', () => {
    const t = tool({ name: 'AskUserQuestion', status: 'running', endedAt: null });
    expect(waitMs(waitsOf([t], at(3)))).toBe(3 * 60_000);
  });

  it('counts no wait for a tool that asks nothing, a todo list included', () => {
    expect(waitsOf([tool({ name: 'TodoWrite' }), tool({ name: 'Read' })], at(10))).toEqual([]);
  });

  it('keeps the agent of the tool call', () => {
    const t = tool({ name: 'AskUserQuestion', agentId: 'sub-1' });
    expect(waitsOf([t], at(10))[0]?.agentId).toBe('sub-1');
  });
});

describe('approvals of a session', () => {
  const run = (over: Partial<RunState>): RunState =>
    ({
      id: 'run-1',
      sessionId: 'claude-code:s1',
      pendingPermissions: [],
      decidedPermissions: [],
      ...over,
    }) as unknown as RunState;

  it('takes the answered and the open prompts of the session’s runs, and no other session’s', () => {
    const runs = [
      run({
        decidedPermissions: [
          {
            id: 'a',
            toolName: 'Bash',
            requestedAt: iso(at(0)),
            decidedAt: iso(at(2)),
            decision: 'allow',
          },
        ],
        pendingPermissions: [
          { id: 'b', toolName: 'Edit', input: {}, questions: null, requestedAt: iso(at(5)) },
        ],
      }),
      run({
        id: 'run-2',
        sessionId: 'claude-code:other',
        pendingPermissions: [
          { id: 'c', toolName: 'Edit', input: {}, questions: null, requestedAt: iso(at(5)) },
        ],
      }),
    ];
    const found = approvalsOf(runs, 'claude-code:s1');
    expect([...found]).toEqual([
      ['a', { requestedAt: at(0), decidedAt: at(2) }],
      ['b', { requestedAt: at(5), decidedAt: null }],
    ]);
    expect(approvalsOf(runs, null).size).toBe(0);
  });
});

describe('waits between prompts', () => {
  const turn = (id: string, from: number, to: number | null, over: Partial<Turn> = {}): Turn => ({
    id,
    agentId: 'main',
    index: 1,
    origin: 'human',
    prompt: 'Next',
    startedAt: iso(from),
    endedAt: to === null ? null : iso(to),
    status: 'complete',
    requestIds: [],
    ...over,
  });

  it('counts the gap from the agent’s reply to the person’s next prompt while a run was live', () => {
    const turns = [turn('a', at(0), at(2)), turn('b', at(7), at(9))];
    expect(turnWaitsOf(turns, at(20), [[at(0), null]])).toEqual([
      { kind: 'turn', agentId: 'main', of: 'b', start: at(2), end: at(7) },
    ]);
  });

  it('counts nothing for a gap across a closed session: no run was live through it', () => {
    const turns = [turn('a', at(0), at(2)), turn('b', at(50), at(52))];
    // The first run closed a minute after the reply; the next began with the new prompt.
    const live = [
      [at(0), at(3)],
      [at(50), null],
    ] as const;
    expect(waitMs(turnWaitsOf(turns, at(60), live))).toBe(60_000);
    expect(turnWaitsOf(turns, at(60), [])).toEqual([]);
    expect(turnWaitsOf(turns, at(60))).toEqual([]);
  });

  it('counts no gap before a prompt the person did not send, nor after the last reply', () => {
    const turns = [
      turn('a', at(0), at(2)),
      turn('b', at(4), at(5), { origin: 'task-notification' }),
      turn('c', at(8), null),
    ];
    expect(turnWaitsOf(turns, at(20), [[at(0), null]])).toEqual([
      { kind: 'turn', agentId: 'main', of: 'c', start: at(5), end: at(8) },
    ]);
  });
});

describe('live spans of a session', () => {
  const run = (over: Partial<RunState>): RunState =>
    ({
      id: 'r',
      sessionId: 's1',
      status: 'idle',
      startedAt: iso(at(0)),
      updatedAt: iso(at(5)),
      ...over,
    }) as unknown as RunState;

  it('runs a live run up to now, a closed or failed one up to its last change', () => {
    const runs = [
      run({ id: 'r1', status: 'closed', startedAt: iso(at(0)), updatedAt: iso(at(5)) }),
      run({ id: 'r2', status: 'error', startedAt: iso(at(6)), updatedAt: iso(at(7)) }),
      run({ id: 'r3', status: 'idle', startedAt: iso(at(8)), updatedAt: iso(at(9)) }),
      run({ id: 'r4', sessionId: 'other' }),
    ];
    expect(liveSpansOf(runs, 's1')).toEqual([
      [at(0), at(5)],
      [at(6), at(7)],
      [at(8), null],
    ]);
    expect(liveSpansOf(runs, null)).toEqual([]);
  });
});
