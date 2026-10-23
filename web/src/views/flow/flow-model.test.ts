import { describe, expect, it } from 'vitest';
import type { ModelRequest, ToolCall, Turn } from '../../../../src/core/model.js';
import type { OpenSession } from '../../data/store';
import { DEMO_NOW, demoOpen, pendingFor, withRunningTool } from '../../test/demo';
import {
  callStatus,
  findTurn,
  isLocalCommand,
  isOutsideTurn,
  requestDurationMs,
  requestsOf,
  tokenHeader,
  toolStatus,
  toolsOf,
  truncatePrompt,
  turnStatus,
  turnsOf,
} from './flow-model';

const req = (open: OpenSession, id: string) => open.requests.get(id) as ModelRequest;
const turn = (open: OpenSession, id: string) => open.turns.get(id) as Turn;
const statusOf = (open: OpenSession, id: string) =>
  callStatus(req(open, id), toolsOf(open, req(open, id)));

describe('truncatePrompt', () => {
  it.each([
    [
      'Busy sessions should be listed first in the sidebar',
      'Busy sessions should be listed first in the sidebar',
    ],
    ['short', 'short'],
    ['  a\n\n  b  ', 'a b'],
    ['x'.repeat(130), `${'x'.repeat(120)}…`],
    ['😀'.repeat(125), `${'😀'.repeat(120)}…`],
    ['', ''],
  ])('%j → %j', (prompt, want) => {
    expect(truncatePrompt(prompt)).toBe(want);
  });

  it('cuts at the given length without leaving a space before the ellipsis', () => {
    expect(truncatePrompt('Research how a live viewer', 15)).toBe('Research how a…');
  });
});

describe('turnsOf / requestsOf / toolsOf', () => {
  it('lists an agent’s turns in order', () => {
    expect(turnsOf(demoOpen(), 'main').map((t) => t.id)).toEqual(['turn_m1', 'turn_m2', 'turn_m3']);
  });

  it('lists a turn’s requests in order', () => {
    const open = demoOpen();
    expect(requestsOf(open, turn(open, 'turn_m1')).map((r) => r.id)).toEqual([
      'req_m1',
      'req_m2',
      'req_m3',
    ]);
  });

  it('includes a request that names the turn before the turn lists it, and skips ids not yet loaded', () => {
    const open = demoOpen();
    const late: ModelRequest = { ...req(open, 'req_m3'), id: 'req_late', index: 4 };
    open.requests = new Map(open.requests).set('req_late', late);
    const t: Turn = {
      ...turn(open, 'turn_m1'),
      requestIds: ['req_m1', 'req_m2', 'req_m3', 'gone'],
    };
    expect(requestsOf(open, t).map((r) => r.id)).toEqual([
      'req_m1',
      'req_m2',
      'req_m3',
      'req_late',
    ]);
  });

  it('lists a request’s tools in block order', () => {
    const open = demoOpen();
    expect(toolsOf(open, req(open, 'req_m2')).map((t) => t.name)).toEqual(['Read', 'Edit']);
  });
});

/** Two main-agent requests the parser could not place in a turn (e.g. before the first prompt). */
function withOrphans(): OpenSession {
  const open = demoOpen();
  const m1 = req(open, 'req_m1');
  const at = (sec: number) =>
    new Date(Date.parse(m1.startedAt as string) - sec * 1000).toISOString();
  open.requests = new Map(open.requests)
    .set('orph_b', {
      ...m1,
      id: 'orph_b',
      turnId: null,
      index: 1,
      startedAt: at(30),
      endedAt: at(25),
      toolCallIds: [],
    })
    .set('orph_a', {
      ...m1,
      id: 'orph_a',
      turnId: null,
      index: 1,
      startedAt: at(60),
      endedAt: at(55),
      toolCallIds: [],
    });
  return open;
}

describe('calls outside any turn', () => {
  it('gathers them in one pseudo-turn, placed by time and in start order', () => {
    const open = withOrphans();
    const turns = turnsOf(open, 'main');
    expect(turns.map((t) => t.id)).toEqual(['outside:main', 'turn_m1', 'turn_m2', 'turn_m3']);
    expect(isOutsideTurn(turns[0] as Turn)).toBe(true);
    expect(requestsOf(open, turns[0] as Turn).map((r) => r.id)).toEqual(['orph_a', 'orph_b']);
  });

  it('adds nothing when every request has a turn', () => {
    expect(turnsOf(demoOpen(), 'main').some(isOutsideTurn)).toBe(false);
  });

  it('can be looked up by id like a real turn', () => {
    const open = withOrphans();
    expect(findTurn(open, 'main', 'outside:main')?.requestIds).toEqual(['orph_a', 'orph_b']);
    expect(findTurn(open, 'main', 'turn_m1')?.id).toBe('turn_m1');
    expect(findTurn(open, 'main', 'outside:other')).toBeUndefined();
  });

  it('makes every request of the agent appear in exactly one turn', () => {
    const open = withOrphans();
    const shown = turnsOf(open, 'main').flatMap((t) => requestsOf(open, t).map((r) => r.id));
    const all = [...open.requests.values()].filter((r) => r.agentId === 'main').map((r) => r.id);
    expect(shown.sort()).toEqual(all.sort());
  });
});

describe('statuses, as in the DSH workflow plugin', () => {
  it('marks a call failed when one of its tools failed', () => {
    expect(statusOf(demoOpen(), 'req_m2')).toBe('error');
  });

  it('marks in-flight requests and calls with a running tool as running', () => {
    const open = demoOpen();
    expect(statusOf(open, 'req_m6')).toBe('running');
    expect(statusOf(open, 'req_w2_9')).toBe('running');
    expect(statusOf(open, 'req_m1')).toBe('complete');
  });

  it('marks an errored or interrupted request', () => {
    const open = demoOpen();
    expect(callStatus({ ...req(open, 'req_m1'), status: 'error' }, [])).toBe('error');
    expect(callStatus({ ...req(open, 'req_m1'), status: 'interrupted' }, [])).toBe('interrupted');
  });

  it('shows a turn that recovered from a failure as complete, and a live one as running', () => {
    const open = demoOpen();
    const of = (id: string) =>
      turnStatus(
        turn(open, id),
        requestsOf(open, turn(open, id)).map((r) => callStatus(r, toolsOf(open, r))),
      );
    expect(of('turn_m1')).toBe('complete');
    expect(of('turn_m3')).toBe('running');
  });

  it('keeps a turn that is still running as running even if its last call finished', () => {
    const t = turn(demoOpen(), 'turn_m1');
    expect(turnStatus({ ...t, status: 'running' }, ['complete', 'complete'])).toBe('running');
  });

  it('falls back to the turn’s own status when it has no calls yet', () => {
    const t = turn(demoOpen(), 'turn_m1');
    expect(turnStatus({ ...t, status: 'running' }, [])).toBe('running');
    expect(turnStatus({ ...t, status: 'unknown' }, [])).toBe('waiting');
  });

  it('maps tool states, with an unfinished tool in a closed session as waiting', () => {
    const tool = demoOpen().toolCalls.get('tu_m1a') as ToolCall;
    expect(toolStatus(tool)).toBe('complete');
    expect(toolStatus({ ...tool, status: 'error' })).toBe('error');
    expect(toolStatus({ ...tool, status: 'running' })).toBe('running');
    expect(toolStatus({ ...tool, status: 'unknown' })).toBe('waiting');
  });

  it('shows a running tool blocked on a permission prompt as waiting for approval', () => {
    const open = withRunningTool(demoOpen(), 'tu_m1a');
    const tool = open.toolCalls.get('tu_m1a') as ToolCall;
    const awaiting = pendingFor('tu_m1a');
    expect(toolStatus(tool, awaiting)).toBe('approval');
    expect(toolStatus(tool, pendingFor('other'))).toBe('running');
    // An answered prompt no longer blocks the tool.
    expect(toolStatus(tool, new Map([['tu_m1a', { requestedAt: 0, decidedAt: 5 }]]))).toBe(
      'running',
    );
    // Only a running tool can be waiting: a finished one keeps its own state.
    expect(toolStatus({ ...tool, status: 'complete' }, awaiting)).toBe('complete');
    const r = req(open, 'req_m1');
    expect(callStatus(r, toolsOf(open, r), awaiting)).toBe('approval');
    expect(
      turnStatus({ ...turn(open, 'turn_m1'), status: 'running' }, ['complete', 'approval']),
    ).toBe('approval');
  });
});

describe('tokenHeader', () => {
  it('splits input into uncached, cache hit and cache write', () => {
    expect(tokenHeader(req(demoOpen(), 'req_m1').usage)).toEqual({
      input: 31_250,
      uncached: 6,
      cacheRead: 244,
      cacheWrite: 31_000,
      output: 820,
      thinking: 610,
      showUncached: true,
    });
  });

  it('hides the uncached split when nothing came from or went to the cache', () => {
    const u = { ...(req(demoOpen(), 'req_m1').usage as NonNullable<ModelRequest['usage']>) };
    expect(tokenHeader({ ...u, cacheRead: 0, cacheWrite: 0 })?.showUncached).toBe(false);
    expect(tokenHeader(null)).toBeNull();
  });
});

describe('requestDurationMs', () => {
  it('reports an unknown duration when the version did not record the request start', () => {
    const m1 = req(demoOpen(), 'req_m1');
    expect(requestDurationMs({ ...m1, startedAt: m1.endedAt }, DEMO_NOW.getTime())).toBeNull();
  });

  it('uses start→end, and start→now while in flight', () => {
    const open = demoOpen();
    expect(requestDurationMs(req(open, 'req_m1'), DEMO_NOW.getTime())).toBe(14_000);
    expect(requestDurationMs(req(open, 'req_m6'), DEMO_NOW.getTime())).toBe(83_000);
    expect(requestDurationMs({ ...req(open, 'req_m1'), startedAt: null }, 0)).toBeNull();
  });
});

describe('isLocalCommand', () => {
  const t = (prompt: string, origin: Turn['origin'] = 'human') =>
    ({ ...turn(demoOpen(), 'turn_m1'), prompt, origin }) as Turn;

  it.each([
    ['/effort', 0, 'complete', true],
    ['/model opus', 0, 'complete', true],
    ['/superpowers:brainstorm', 0, 'interrupted', true],
    ['  /clear', 0, 'complete', true],
    // Answered by the model (a skill, a custom command): a conversation like any other.
    ['/review the parser', 2, 'complete', false],
    // Still starting: its first call may be on the way.
    ['/review', 0, 'running', false],
    ['/review', 0, 'approval', false],
    // A path is not a command.
    ['/home/user/app.log what is wrong here', 0, 'complete', false],
    ['/', 0, 'complete', false],
    ['fix /effort handling', 0, 'complete', false],
  ] as const)('%s with %i calls (%s) → %s', (prompt, calls, status, expected) => {
    expect(isLocalCommand(t(prompt), calls, status)).toBe(expected);
  });

  it('only counts what a person typed', () => {
    expect(isLocalCommand(t('/effort', 'peer'), 0, 'complete')).toBe(false);
    expect(isLocalCommand(t('/effort', 'agent-prompt'), 0, 'complete')).toBe(false);
  });
});
