import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionActivity, SessionSummary, TroubleSignal } from '../../../../src/core/model.js';
import type { PermissionRequest, RunState } from '../../../../src/shared/runs.js';
import { needsYou } from '../../data/needs-you';
import { openPrompts, withWaiting } from '../../data/runs';
import { inboxItems } from './items';

const NOW = Date.parse('2026-10-26T10:00:00.000Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

let n = 0;
function session(live: SessionSummary['live'], more: Partial<SessionSummary> = {}): SessionSummary {
  n++;
  return {
    id: `claude-code:s${n}`,
    agent: 'claude-code',
    nativeId: `s${n}`,
    title: `Session ${n}`,
    cwd: '/w/garden',
    project: 'garden',
    startedAt: ago(7200),
    updatedAt: ago(600),
    live,
    version: null,
    model: null,
    usage: null,
    counts: null,
    ...more,
  };
}
const waitingOn = (
  tool: string | null,
  s: number,
  target: string | null = null,
): SessionActivity => ({
  kind: 'waiting',
  tool,
  target,
  agentId: 'main',
  since: ago(s),
});
const sign = (kind: TroubleSignal['kind'], s: number | null): TroubleSignal => ({
  kind,
  params: { x: 'npm test', n: 4 },
  at: null,
  since: s === null ? null : ago(s),
});
function ask(id: string, toolName: string, s: number, input: unknown = {}): PermissionRequest {
  return {
    id,
    toolName,
    input,
    questions:
      toolName === 'AskUserQuestion'
        ? [{ question: 'Which beds first?', header: 'Beds', multiSelect: false, options: [] }]
        : null,
    requestedAt: ago(s),
  };
}
function run(id: string, sessionId: string, ...pending: PermissionRequest[]): RunState {
  return {
    id,
    sessionId,
    cwd: '/w/garden',
    mode: 'fork',
    status: pending.length > 0 ? 'waiting-permission' : 'running',
    permissionMode: 'default',
    startedAt: ago(900),
    updatedAt: ago(1),
    pendingPermissions: pending,
    partial: null,
    error: null,
    last: null,
  };
}

/** The items as App lists them: the runs' prompts folded into the sessions, then the inbox's. */
function items(sessions: SessionSummary[], runs: RunState[], showProbes = false) {
  const prompts = openPrompts(new Map(runs.map((r) => [r.id, r])));
  const listed = withWaiting(sessions, new Map([...prompts].map(([id, p]) => [id, p.request])));
  return inboxItems(listed, prompts, showProbes);
}

describe('inboxItems', () => {
  beforeEach(() => {
    n = 0;
  });

  it('makes one item of each thing waiting: a run’s prompt, question or plan, a terminal’s wait', () => {
    const permission = session('busy');
    const question = session('busy');
    const plan = session('busy');
    const terminal = session('waiting', { activity: waitingOn('Bash', 30, 'git push +1') });
    const turn = session('waiting', { updatedAt: ago(20) });
    const got = items(
      [permission, question, plan, terminal, turn],
      [
        run('r1', permission.id, ask('tu_1', 'Bash', 50, { command: 'npm test' })),
        run('r2', question.id, ask('tu_2', 'AskUserQuestion', 40)),
        run('r3', plan.id, ask('tu_3', 'ExitPlanMode', 35, { plan: '## Plan' })),
      ],
    );
    expect(got.map((i) => [i.kind, i.session.title])).toEqual([
      ['permission', 'Session 1'],
      ['question', 'Session 2'],
      ['plan', 'Session 3'],
      ['terminal', 'Session 4'],
      ['terminal', 'Session 5'],
    ]);
    const [p] = got;
    expect(p?.kind === 'permission' && p.prompt).toEqual({
      runId: 'r1',
      request: expect.objectContaining({ id: 'tu_1', toolName: 'Bash' }),
    });
    // The run's prompt is what the item waits on: its session is listed as waiting for it.
    expect(p?.session.live).toBe('waiting');
    expect(got.map((i) => i.id)).toEqual([
      'wait:claude-code:s1',
      'wait:claude-code:s2',
      'wait:claude-code:s3',
      'wait:claude-code:s4',
      'wait:claude-code:s5',
    ]);
  });

  it('asks a question only with its questions, else asks permission for the ask tool', () => {
    const s = session('busy');
    const bare = { ...ask('tu_1', 'AskUserQuestion', 10), questions: null };
    expect(items([s], [run('r1', s.id, bare)]).map((i) => i.kind)).toEqual(['permission']);
  });

  it('puts the waits first, the oldest first, then the sessions that look stuck, the oldest sign first', () => {
    const stuckLate = session('busy', { trouble: sign('repeat', 60) });
    const waitShort = session('waiting', { activity: waitingOn('Bash', 30) });
    const stuckEarly = session('busy', { trouble: sign('failing', 900) });
    const stuckUndated = session('busy', { trouble: sign('compaction', null) });
    const prompted = session('busy');
    const waitLong = session('waiting', { activity: waitingOn('Edit', 300) });
    const got = items(
      [stuckLate, waitShort, stuckEarly, stuckUndated, prompted, waitLong],
      [run('r1', prompted.id, ask('tu_1', 'Bash', 120))],
    );
    expect(got.map((i) => [i.kind, i.session.title])).toEqual([
      ['terminal', 'Session 6'],
      ['permission', 'Session 5'],
      ['terminal', 'Session 2'],
      ['stuck', 'Session 3'],
      ['stuck', 'Session 1'],
      ['stuck', 'Session 4'],
    ]);
    const stuck = got.at(3);
    expect(stuck?.kind === 'stuck' && [stuck.id, stuck.sign.kind]).toEqual([
      'stuck:claude-code:s3',
      'failing',
    ]);
  });

  it('lists a session that waits once, as its wait, whatever its sign says', () => {
    const s = session('waiting', {
      activity: waitingOn('Bash', 700),
      trouble: sign('waiting', 700),
    });
    expect(items([s], []).map((i) => i.id)).toEqual(['wait:claude-code:s1']);
  });

  it('leaves out a sign of a session no longer running, and one with no sign', () => {
    const sessions = [
      session('idle', { trouble: sign('repeat', 60) }),
      session('closed', { trouble: sign('repeat', 60) }),
      session('busy', { trouble: null }),
      session('busy'),
    ];
    expect(items(sessions, [])).toEqual([]);
  });

  it('leaves the hidden probes out unless they are shown', () => {
    const sessions = [
      session('waiting', { tags: ['probe'], activity: waitingOn('Bash', 30) }),
      session('busy', { tags: ['probe'], trouble: sign('repeat', 60) }),
    ];
    expect(items(sessions, [])).toEqual([]);
    expect(items(sessions, [], true).map((i) => i.kind)).toEqual(['terminal', 'stuck']);
  });

  it('waits on as many items as Home lists under Needs you', () => {
    const sessions = [
      session('waiting', { activity: waitingOn('Bash', 30) }),
      session('busy'),
      session('busy', { trouble: sign('repeat', 60) }),
      session('waiting', { tags: ['probe'], activity: waitingOn('Bash', 30) }),
      session('idle'),
    ];
    const runs = [run('r1', 'claude-code:s2', ask('tu_1', 'Bash', 10))];
    const got = items(sessions, runs);
    const prompts = openPrompts(new Map(runs.map((r) => [r.id, r])));
    const listed = withWaiting(sessions, new Map([...prompts].map(([id, p]) => [id, p.request])));
    expect(got.filter((i) => i.kind !== 'stuck')).toHaveLength(needsYou(listed, false).length);
  });
});
