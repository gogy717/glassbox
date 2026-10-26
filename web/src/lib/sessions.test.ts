import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../../src/core/model.js';
import {
  CLOSED_SHOWN,
  foldClosed,
  groupNames,
  groupSessions,
  isRunning,
  liveFilterOf,
  timeBucket,
} from './sessions';

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
  s('c1', 'gamma', '09:50', { cwd: '/w/gamma' }),
  s('a3', 'alpha', '09:40', { live: 'closed' }),
];

// A project group's key is its name; the pinned and time groups' keys start with a slash.
const ids = (groups: ReturnType<typeof groupSessions>) =>
  groups.map((g) => [g.key, g.sessions.map((x) => x.id)]);

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
    expect(ids(groupSessions(sessions, ' /W/GAM '))).toEqual([['gamma', ['c1']]]);
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

// Branch D (F7): the time groups' day boundaries, by the browser's calendar.
describe('timeBucket', () => {
  // A Wednesday at noon, local time: Monday 00:00 is this week's start.
  const now = new Date(2026, 9, 28, 12, 0, 0).getTime();
  const at = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) =>
    new Date(y, mo, d, h, mi, s).toISOString();

  it('puts today, yesterday, the week from Monday and the rest in their groups', () => {
    expect(timeBucket(at(2026, 9, 28, 0), now)).toBe('today');
    expect(timeBucket(at(2026, 9, 27, 23, 59, 59), now)).toBe('yesterday');
    expect(timeBucket(at(2026, 9, 27, 0), now)).toBe('yesterday');
    expect(timeBucket(at(2026, 9, 26, 23, 59, 59), now)).toBe('week');
    expect(timeBucket(at(2026, 9, 26, 0), now)).toBe('week');
    expect(timeBucket(at(2026, 9, 25, 23, 59, 59), now)).toBe('earlier');
    expect(timeBucket(at(2026, 9, 1, 9), now)).toBe('earlier');
  });

  it('counts a time a little ahead of the clock as today, and one it cannot read as earlier', () => {
    expect(timeBucket(at(2026, 9, 28, 12, 0, 5), now)).toBe('today');
    expect(timeBucket('not a time', now)).toBe('earlier');
  });

  it('leaves this week empty on a Monday or a Tuesday: those days are today and yesterday', () => {
    const tuesday = new Date(2026, 9, 27, 9, 0, 0).getTime();
    expect(timeBucket(at(2026, 9, 26, 10), tuesday)).toBe('yesterday');
    expect(timeBucket(at(2026, 9, 25, 10), tuesday)).toBe('earlier');
  });
});

// Branch D (F7) item 5: group names from paths alone, no project file read.
describe('groupNames', () => {
  const named = (dirs: (string | null)[], project = 'x') => {
    const list = dirs.map((cwd, i) => ({ ...base, id: `s${i}`, cwd, project }));
    const name = groupNames(list);
    return list.map(name);
  };

  it('prefixes a worktree with its repository: a parent named like another session’s directory', () => {
    expect(
      named([
        '/home/dev/src/glassbox',
        '/home/dev/work/glassbox/weever',
        '/home/dev/work/glassbox/opaleye-2',
        '/home/dev/src/blog',
      ]),
    ).toEqual(['glassbox', 'glassbox/weever', 'glassbox/opaleye-2', 'blog']);
  });

  it('leaves unrelated siblings alone: a parent that is nobody’s project names nothing', () => {
    expect(named(['/home/dev/src/blog', '/home/dev/src/shopfront'])).toEqual(['blog', 'shopfront']);
    // Worktrees with no main clone among the sessions read as their own directory.
    expect(named(['/w/glassbox/weever', '/w/glassbox/pm-d'])).toEqual(['weever', 'pm-d']);
  });

  it('does not take a directory inside a project the user also works in for a worktree', () => {
    expect(named(['/home/dev/src/api', '/home/dev/src/api/web'])).toEqual(['api', 'web']);
  });

  it('tells two directories that read alike apart with as many parents as it takes', () => {
    expect(named(['/home/dev/work/api', '/home/dev/home/api'])).toEqual(['work/api', 'home/api']);
    expect(named(['/a/x/api', '/b/x/api', '/c/other'])).toEqual(['a/x/api', 'b/x/api', 'other']);
  });

  it('reads Windows paths and trailing separators as the same directories', () => {
    expect(named(['C:\\w\\glassbox\\', 'D:\\clones\\glassbox\\weever', '/w/blog/'])).toEqual([
      'glassbox',
      'glassbox/weever',
      'blog',
    ]);
    // The same directory written twice is one group.
    expect(named(['/w/blog', '/w/blog/'])).toEqual(['blog', 'blog']);
  });

  it('keeps the server’s name for a session without a directory', () => {
    expect(named([null, '/w/blog'], 'codex')).toEqual(['codex', 'blog']);
    expect(named(['/'], 'root')).toEqual(['root']);
  });
});

// Branch D (F7) item 4: a group lists its running and idle sessions and the 5 most recently
// closed; the rest wait behind "N more".
describe('groupSessions by repository', () => {
  const repo = (root: string, dir = root) => ({
    root,
    dir,
    name: root.split('/').at(-1) as string,
  });
  const list = [
    s('main', 'glassbox', '09:00', {
      cwd: '/home/dev/src/glassbox',
      repo: repo('/home/dev/src/glassbox'),
    }),
    s('w1', 'weever', '09:30', {
      cwd: '/home/dev/work/glassbox/weever',
      repo: repo('/home/dev/src/glassbox', '/home/dev/work/glassbox/weever'),
      live: 'busy',
    }),
    s('w1b', 'weever', '08:00', {
      cwd: '/home/dev/work/glassbox/weever/web',
      repo: repo('/home/dev/src/glassbox', '/home/dev/work/glassbox/weever'),
    }),
    s('w2', 'opaleye', '09:40', {
      cwd: '/home/dev/work/glassbox/opaleye',
      repo: repo('/home/dev/src/glassbox', '/home/dev/work/glassbox/opaleye'),
    }),
    s('notes', 'notes', '09:50', { cwd: '/home/dev/notes', repo: null }),
    s('old', 'blog', '09:20', { cwd: '/home/dev/src/blog' }),
  ];

  it('gathers every worktree of a repository under its name, wherever the worktrees are', () => {
    const groups = groupSessions(list, '');
    expect(ids(groups)).toEqual([
      ['glassbox', ['w1', 'w2', 'main', 'w1b']],
      ['notes', ['notes']],
      ['blog', ['old']],
    ]);
    const g = groups[0];
    if (g?.kind !== 'project') throw new Error('project group');
    // Several directories: the group names the repository's root.
    expect(g.cwd).toBe('/home/dev/src/glassbox');
  });

  it('splits such a group by working tree: the main one first, then by their running sessions', () => {
    const g = groupSessions(list, '')[0];
    if (g?.kind !== 'project') throw new Error('project group');
    expect(g.worktrees?.map((w) => [w.name, w.main, w.sessions.map((x) => x.id)])).toEqual([
      ['glassbox', true, ['main']],
      ['weever', false, ['w1', 'w1b']],
      ['opaleye', false, ['w2']],
    ]);
  });

  it('has no working trees to show for one tree, or when a session’s repository is unknown', () => {
    const groups = groupSessions(list, '');
    expect(groups.slice(1).map((g) => (g.kind === 'project' ? g.worktrees : 'x'))).toEqual([
      null,
      null,
    ]);
    const one = groupSessions([list[0] as SessionSummary], '')[0];
    expect(one?.kind === 'project' && one.worktrees).toBeNull();
  });

  it('tells two repositories of one name apart by their parents, like directories', () => {
    const two = groupSessions(
      [...list, s('other', 'glassbox', '07:00', { cwd: '/x/glassbox', repo: repo('/x/glassbox') })],
      '',
    );
    expect(ids(two).map(([k]) => k)).toEqual(['src/glassbox', 'notes', 'blog', 'x/glassbox']);
  });

  it('groups a worktree the server read with the repository even when paths say otherwise', () => {
    // A session in the repository, one in a worktree far away, and a stranger named like it.
    const groups = groupSessions(
      [
        list[0] as SessionSummary,
        s('far', 'tree', '09:10', {
          cwd: '/tmp/tree',
          repo: repo('/home/dev/src/glassbox', '/tmp/tree'),
        }),
        s('stranger', 'glassbox', '09:05', { cwd: '/elsewhere/glassbox' }),
      ],
      '',
    );
    expect(ids(groups)).toEqual([
      ['src/glassbox', ['far', 'main']],
      ['elsewhere/glassbox', ['stranger']],
    ]);
  });
});

describe('foldClosed', () => {
  const closed = (id: string, hhmm: string) => s(id, 'p', hhmm, { live: 'closed' });
  const list = [
    s('busy', 'p', '09:59', { live: 'busy' }),
    s('idle1', 'p', '09:40'),
    closed('c1', '09:30'),
    closed('c2', '09:20'),
    s('idle2', 'p', '09:15'),
    closed('c3', '09:10'),
    closed('c4', '09:00'),
    closed('c5', '08:50'),
    closed('c6', '08:40'),
    s('lost', 'p', '08:30', { live: 'unknown' }),
    closed('c8', '08:20'),
  ];
  const ids = (xs: SessionSummary[]) => xs.map((x) => x.id);

  it('shows every running and idle session and the 5 most recent closed, in the group’s order', () => {
    expect(CLOSED_SHOWN).toBe(5);
    const { shown, more } = foldClosed(list);
    expect(ids(shown)).toEqual(['busy', 'idle1', 'c1', 'c2', 'idle2', 'c3', 'c4', 'c5']);
    // An unknown state counts as closed, as the state filter counts it.
    expect(ids(more)).toEqual(['c6', 'lost', 'c8']);
  });

  it('keeps the open session on show wherever it falls, without taking a slot', () => {
    const { shown, more } = foldClosed(list, 'c8');
    expect(ids(shown)).toEqual(['busy', 'idle1', 'c1', 'c2', 'idle2', 'c3', 'c4', 'c5', 'c8']);
    expect(ids(more)).toEqual(['c6', 'lost']);
  });

  it('has nothing more when the closed sessions fit', () => {
    const { shown, more } = foldClosed(list.slice(0, 8));
    expect(ids(shown)).toHaveLength(8);
    expect(more).toEqual([]);
  });
});

// Branch D (F7): pins, time groups and the names from paths, as the sidebar lists them.
describe('groupSessions pins, time groups and names', () => {
  it('names a worktree under its repository, and tells the group its directory', () => {
    const list = [
      s('main', 'glassbox', '09:00', { cwd: '/home/dev/src/glassbox' }),
      s('tree', 'weever', '09:30', { cwd: '/home/dev/work/glassbox/weever' }),
      s('tree2', 'weever', '08:00', { cwd: '/home/dev/work/glassbox/weever/' }),
      s('nowhere', 'codex', '07:00'),
    ];
    const groups = groupSessions(list, '');
    expect(ids(groups)).toEqual([
      ['glassbox/weever', ['tree', 'tree2']],
      ['glassbox', ['main']],
      ['codex', ['nowhere']],
    ]);
    expect(groups.map((g) => (g.kind === 'project' ? g.cwd : null))).toEqual([
      '/home/dev/work/glassbox/weever',
      '/home/dev/src/glassbox',
      null,
    ]);
    // Two repositories of one name read with their parents; the groups still rank by their
    // newest session.
    const mixed = groupSessions(
      [...list, s('main2', 'glassbox', '06:00', { cwd: '/x/glassbox' })],
      '',
    );
    expect(ids(mixed).map(([k]) => k)).toEqual([
      'glassbox/weever',
      'src/glassbox',
      'codex',
      'x/glassbox',
    ]);
  });

  it('keeps the names whatever the search or the filters leave', () => {
    const list = [
      s('main', 'glassbox', '09:00', { cwd: '/home/dev/src/glassbox' }),
      s('tree', 'weever', '09:30', { cwd: '/home/dev/work/glassbox/weever', title: 'Pins' }),
    ];
    expect(ids(groupSessions(list, 'pins'))).toEqual([['glassbox/weever', ['tree']]]);
  });

  it('lists pinned sessions first, in the order pinned, out of their own groups', () => {
    const groups = groupSessions(sessions, '', { pinned: ['c1', 'a1', 'gone'] });
    expect(ids(groups)).toEqual([
      ['/pinned', ['c1', 'a1']],
      ['alpha', ['a2', 'a3']],
      ['beta', ['b1']],
    ]);
    expect(groups[0]?.kind).toBe('pinned');
    // Pins answer to the search and the filters like any row.
    expect(ids(groupSessions(sessions, 'parser', { pinned: ['c1'] }))).toEqual([['alpha', ['a2']]]);
    expect(ids(groupSessions(sessions, '', { pinned: ['a3'], live: 'running' }))).toEqual([
      ['alpha', ['a2']],
    ]);
    expect(
      ids(groupSessions(sessions, '', { pinned: ['a3'], live: 'running', keep: 'a3' })),
    ).toEqual([
      ['/pinned', ['a3']],
      ['alpha', ['a2']],
    ]);
  });

  it('groups by time when asked: today, yesterday, this week, earlier; running first inside', () => {
    // A Thursday at noon, local time.
    const now = new Date(2026, 9, 29, 12, 0, 0).getTime();
    const at = (d: number, h: number) => new Date(2026, 9, d, h, 0, 0).toISOString();
    const list = [
      s('old', 'p', '', { updatedAt: at(20, 9) }),
      s('mon', 'q', '', { updatedAt: at(26, 9), live: 'closed' }),
      s('yday', 'p', '', { updatedAt: at(28, 9) }),
      s('now', 'r', '', { updatedAt: at(29, 11) }),
      s('busy', 'p', '', { updatedAt: at(29, 8), live: 'busy' }),
      s('tue', 'p', '', { updatedAt: at(27, 22) }),
    ];
    const groups = groupSessions(list, '', { groupBy: 'time', now, pinned: ['mon'] });
    expect(ids(groups)).toEqual([
      ['/pinned', ['mon']],
      ['/today', ['busy', 'now']],
      ['/yesterday', ['yday']],
      ['/week', ['tue']],
      ['/earlier', ['old']],
    ]);
    expect(groups.map((g) => (g.kind === 'time' ? g.bucket : g.kind))).toEqual([
      'pinned',
      'today',
      'yesterday',
      'week',
      'earlier',
    ]);
    // Groups with nothing in them are left out.
    expect(ids(groupSessions(list.slice(0, 1), '', { groupBy: 'time', now }))).toEqual([
      ['/earlier', ['old']],
    ]);
  });
});
