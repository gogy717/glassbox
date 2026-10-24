import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../../src/core/model.js';
import { groupSessions, isRunning, liveFilterOf } from './sessions';

const base: SessionSummary = {
  id: 'x',
  agent: 'claude-code',
  nativeId: 'x',
  title: null,
  cwd: null,
  project: 'p',
  startedAt: null,
  updatedAt: '2026-10-23T10:00:00.000Z',
  live: 'idle',
  version: null,
  model: null,
  usage: null,
  counts: null,
};
const s = (id: string, project: string, updatedAt: string, over: Partial<SessionSummary> = {}) => ({
  ...base,
  id,
  project,
  updatedAt: `2026-10-23T${updatedAt}:00.000Z`,
  ...over,
});

const sessions: SessionSummary[] = [
  s('a1', 'alpha', '09:00'),
  s('b1', 'beta', '09:30'),
  s('a2', 'alpha', '08:00', { live: 'busy', title: 'Refactor Parser', cwd: '/w/alpha' }),
  s('c1', 'gamma', '09:50', { cwd: '/w/gamma-tools' }),
  s('a3', 'alpha', '09:40', { live: 'closed' }),
];

const ids = (groups: ReturnType<typeof groupSessions>) =>
  groups.map((g) => [g.project, g.sessions.map((x) => x.id)]);

// Final review M8: one test of "running", which busy and waiting both are.
describe('isRunning', () => {
  it.each([
    ['busy', true],
    ['waiting', true],
    ['idle', false],
    ['closed', false],
  ] as const)('counts a session that is %s as running: %s', (live, running) => {
    expect(isRunning({ live })).toBe(running);
  });
});

describe('groupSessions', () => {
  it('puts groups with a busy session first, then by most recent update; busy first inside', () => {
    expect(ids(groupSessions(sessions, ''))).toEqual([
      ['alpha', ['a2', 'a3', 'a1']],
      ['gamma', ['c1']],
      ['beta', ['b1']],
    ]);
  });

  it('ranks a session waiting for the user like a busy one', () => {
    const list = [
      s('b1', 'beta', '09:30'),
      s('d1', 'delta', '07:00', { live: 'waiting' }),
      s('d2', 'delta', '09:59'),
    ];
    expect(ids(groupSessions(list, ''))).toEqual([
      ['delta', ['d1', 'd2']],
      ['beta', ['b1']],
    ]);
  });

  it('hides probe sessions, even busy ones, unless asked to show them', () => {
    const list = [
      s('p1', 'Probe', '09:59', { live: 'busy', title: 'ClaudeBar Probe', tags: ['probe'] }),
      s('b1', 'beta', '09:30'),
    ];
    expect(ids(groupSessions(list, ''))).toEqual([['beta', ['b1']]]);
    expect(ids(groupSessions(list, '', { showProbes: true }))).toEqual([
      ['Probe', ['p1']],
      ['beta', ['b1']],
    ]);
  });

  it('filters by title or cwd, case-insensitively, dropping empty groups', () => {
    expect(ids(groupSessions(sessions, 'parser'))).toEqual([['alpha', ['a2']]]);
    expect(ids(groupSessions(sessions, ' GAMMA-T '))).toEqual([['gamma', ['c1']]]);
    expect(groupSessions(sessions, 'nothing matches')).toEqual([]);
  });
});

describe('groupSessions filters', () => {
  const mixed: SessionSummary[] = [
    s('busy', 'alpha', '09:00', { live: 'busy', title: 'Port the theme' }),
    s('wait', 'beta', '09:10', { live: 'waiting', agent: 'codex', title: 'Tighten retry' }),
    s('idle', 'alpha', '09:20', { live: 'idle', title: 'Port the tokens' }),
    s('shut', 'gamma', '09:30', { live: 'closed', agent: 'codex' }),
    s('lost', 'gamma', '09:40', { live: 'unknown' }),
  ];
  const listed = (opts: Parameters<typeof groupSessions>[2], query = '') =>
    groupSessions(mixed, query, opts).flatMap((g) => g.sessions.map((x) => x.id));

  it('counts waiting as running, and an unknown state as closed', () => {
    expect(mixed.map(liveFilterOf)).toEqual(['running', 'running', 'idle', 'closed', 'closed']);
    expect(listed({ live: 'running' }).sort()).toEqual(['busy', 'wait']);
    expect(listed({ live: 'closed' }).sort()).toEqual(['lost', 'shut']);
  });

  it('composes the live filter with the agent filter and the text query', () => {
    expect(listed({ live: 'running', agent: 'codex' })).toEqual(['wait']);
    expect(listed({ live: 'running' }, 'port')).toEqual(['busy']);
    expect(listed({ agent: 'claude-code' }, 'port').sort()).toEqual(['busy', 'idle']);
  });

  it('keeps the open session whatever the filters say, but not past the text query', () => {
    expect(listed({ live: 'running', keep: 'shut' }).sort()).toEqual(['busy', 'shut', 'wait']);
    expect(listed({ agent: 'codex', keep: 'idle' }).sort()).toEqual(['idle', 'shut', 'wait']);
    expect(listed({ live: 'running', keep: 'shut' }, 'retry')).toEqual(['wait']);
  });
});
