import { describe, expect, it, vi } from 'vitest';
import type {
  LiveState,
  RepoIdentity,
  SessionSnapshot,
  SessionSummary,
  ToolCall,
} from '../core/model.js';
import type { RulesResult, SettingsFile } from '../shared/permissions.js';
import { RulesService } from './rules.js';
import type { WeekStore } from './week.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const tick = () => new Promise((r) => setTimeout(r, 2));

const repo = (root: string, dir = root): RepoIdentity => ({
  root,
  dir,
  name: root.split('/').at(-1) ?? root,
});

interface SnapOpts {
  agent?: string;
  cwd?: string | null;
  repo?: RepoIdentity | null;
  /** Days before NOW it was last written. */
  daysAgo?: number;
  live?: LiveState;
  commands?: string[];
  calls?: Partial<ToolCall>[];
}

function snap(id: string, o: SnapOpts = {}): SessionSnapshot {
  const updated = NOW - (o.daysAgo ?? 1) * DAY;
  const cwd = o.cwd === undefined ? '/work/shop' : o.cwd;
  const calls: ToolCall[] = [
    ...(o.commands ?? []).map((command) => ({ name: 'Bash', input: { command } })),
    ...(o.calls ?? []),
  ].map((c, i) => ({
    id: `${id}-t${i}`,
    agentId: 'main',
    requestId: `${id}-r`,
    name: 'Bash',
    input: {},
    status: 'complete',
    startedAt: iso(updated - (i + 1) * 60_000),
    endedAt: null,
    durationMs: null,
    resultPreview: 'ok',
    hasFullResult: false,
    spawned: null,
    ...c,
  }));
  const session: SessionSummary = {
    id,
    agent: o.agent ?? 'claude-code',
    nativeId: id,
    title: null,
    cwd,
    project: cwd?.split('/').at(-1) ?? 'unknown',
    ...(o.repo !== undefined ? { repo: o.repo } : cwd ? { repo: repo(cwd) } : {}),
    startedAt: iso(updated - DAY),
    updatedAt: iso(updated),
    live: o.live ?? 'closed',
    version: null,
    model: null,
    usage: null,
    counts: null,
  };
  return {
    session,
    agents: [],
    turns: [],
    requests: [],
    toolCalls: calls,
    workflows: [],
    diagnostics: { unknownRecordTypes: {}, parseErrors: 0, unavailable: [] },
  };
}

function fakeStore(snaps: SessionSnapshot[], sizes: Record<string, number> = {}) {
  const reads: string[] = [];
  const store: WeekStore = {
    weekSessions: () => snaps.map((s) => s.session),
    readSession: async (id) => {
      reads.push(id);
      await tick();
      const snapshot = snaps.find((s) => s.session.id === id);
      return snapshot ? { snapshot, bytes: sizes[id] ?? 100 } : null;
    },
    sizeOf: async (id) => sizes[id] ?? 100,
  };
  return { store, reads };
}

const asked = (r: RulesResult) => r.rows.map((row) => [row.key, row.asked]);

describe('the rules service', () => {
  it('counts the window’s sessions by rule, reading none written before it, nor any agent without rules', async () => {
    const { store, reads } = fakeStore([
      snap('a', { daysAgo: 1, commands: ['npm test', 'npm test -- x'] }),
      snap('b', { daysAgo: 10, cwd: '/work/blog', commands: ['npm test'] }),
      snap('c', { daysAgo: 40, commands: ['make'] }),
      snap('d', {
        daysAgo: 1,
        agent: 'grok',
        calls: [{ name: 'bash', input: { command: 'npm test' } }],
      }),
    ]);
    const rules = new RulesService(store, { now: () => NOW });

    const week = await rules.compute('7d');
    expect(reads).toEqual(['a']);
    expect(asked(week)).toEqual([['Bash(npm test:*)', 2]]);
    expect(week.window).toEqual({ kind: '7d', from: NOW - 7 * DAY, now: NOW });

    const month = await rules.compute('30d');
    expect(reads).toEqual(['a', 'b']);
    expect(asked(month)).toEqual([['Bash(npm test:*)', 3]]);
    expect(month.rows[0]?.projects.map((p) => [p.root, p.name, p.asked])).toEqual([
      ['/work/shop', 'shop', 2],
      ['/work/blog', 'blog', 1],
    ]);

    const all = await rules.compute('all');
    expect(reads).toEqual(['a', 'b', 'c']);
    expect(asked(all)).toEqual([
      ['Bash(npm test:*)', 3],
      ['Bash(make:*)', 1],
    ]);
    expect(all.stats).toMatchObject({ considered: 3, read: 1, cached: 2, failed: 0 });
  });

  it('reads a session once, and again when it changed, or runs and was read 30 s ago or more', async () => {
    const snaps = [
      snap('a', { commands: ['npm test'] }),
      snap('b', { live: 'busy', commands: ['npm test'] }),
    ];
    const { store, reads } = fakeStore(snaps);
    let now = NOW;
    const rules = new RulesService(store, { now: () => now });
    await rules.compute('30d');
    await rules.compute('30d');
    expect(reads).toEqual(['a', 'b']);

    now += 30_000;
    await rules.compute('30d');
    expect(reads).toEqual(['a', 'b', 'b']);

    snaps[0] = snap('a', { daysAgo: 0, commands: ['npm test', 'make'] });
    const changed = await rules.compute('30d');
    expect(reads).toEqual(['a', 'b', 'b', 'a']);
    expect(asked(changed)).toEqual([
      ['Bash(npm test:*)', 2],
      ['Bash(make:*)', 1],
    ]);

    await rules.compute('30d', { refresh: true });
    expect(reads.slice(4)).toEqual(['b']);
  });

  it('a session gone from the list is gone from the rules', async () => {
    const snaps = [snap('a', { commands: ['npm test'] }), snap('b', { commands: ['make'] })];
    const { store } = fakeStore(snaps);
    const rules = new RulesService(store, { now: () => NOW });
    await rules.compute('30d');
    snaps.pop();
    expect(asked(await rules.compute('30d'))).toEqual([['Bash(npm test:*)', 1]]);
  });

  it('reads the smallest session first', async () => {
    const { store, reads } = fakeStore(
      [
        snap('a', { commands: ['x'] }),
        snap('b', { commands: ['y'] }),
        snap('c', { commands: ['z'] }),
      ],
      { a: 300, b: 100, c: 200 },
    );
    await new RulesService(store, { now: () => NOW, concurrency: 1 }).compute('30d');
    expect(reads).toEqual(['b', 'c', 'a']);
  });

  it('says how far it got, never going back, ending with every session', async () => {
    const { store } = fakeStore([snap('a', { commands: ['x'] }), snap('b', { commands: ['y'] })]);
    const heard: [number, number][] = [];
    await new RulesService(store, { now: () => NOW }).compute('30d', {}, (p) =>
      heard.push([p.done, p.total]),
    );
    expect(heard[0]).toEqual([0, 2]);
    expect(heard.at(-1)).toEqual([2, 2]);
    const dones = heard.map(([d]) => d);
    expect(dones).toEqual([...dones].sort((x, y) => x - y));
  });

  it('computes once for requests made together', async () => {
    const { store, reads } = fakeStore([
      snap('a', { commands: ['x'] }),
      snap('b', { commands: ['y'] }),
    ]);
    const rules = new RulesService(store, { now: () => NOW });
    const [one, two] = await Promise.all([rules.compute('30d'), rules.compute('30d')]);
    expect(reads.sort()).toEqual(['a', 'b']);
    expect(one).toEqual(two);
  });

  it('reads the settings of the projects asked in, worktrees included, and says which rules they hold', async () => {
    const { store } = fakeStore([
      snap('a', { commands: ['npm test'] }),
      snap('b', {
        cwd: '/work/shop-wt',
        repo: repo('/work/shop', '/work/shop-wt'),
        commands: ['make'],
      }),
      snap('c', { cwd: '/work/notes', repo: null, commands: ['npm run lint'] }),
      snap('d', { cwd: '/work/quiet', commands: [] }),
    ]);
    const file: SettingsFile = {
      path: '/home/dev/.claude/settings.json',
      scope: 'global',
      root: null,
      allow: ['Bash(npm:*)'],
      deny: [],
    };
    const readSettings = vi.fn(async () => [file]);
    const result = await new RulesService(store, { now: () => NOW, readSettings }).compute('30d');
    expect(readSettings).toHaveBeenCalledWith([
      { root: '/work/shop', dirs: ['/work/shop', '/work/shop-wt'] },
      { root: '/work/notes', dirs: ['/work/notes'] },
    ]);
    expect(result.settings).toEqual([file]);
    const npm = result.rows.find((r) => r.key === 'Bash(npm test:*)');
    expect(npm?.inSettings).toEqual([
      { path: file.path, scope: 'global', root: null, list: 'allow', rule: 'Bash(npm:*)' },
    ]);
    expect(result.rows.find((r) => r.key === 'Bash(npm run lint:*)')?.projects[0]).toMatchObject({
      root: '/work/notes',
      name: 'notes',
    });
  });

  it('counts a rule for the settings file it would go to as if it held none, when settings cannot be read', async () => {
    const { store } = fakeStore([snap('a', { commands: ['npm test'] })]);
    const log = vi.fn();
    const result = await new RulesService(store, {
      now: () => NOW,
      readSettings: async () => {
        throw new Error('EACCES');
      },
      log,
    }).compute('30d');
    expect(result.settings).toEqual([]);
    expect(result.rows[0]?.inSettings).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });

  it('takes the answers glassbox runs keep, writing keys under home as ~', async () => {
    const { store } = fakeStore([
      snap('a', {
        calls: [
          {
            id: 'x1',
            name: 'Bash',
            input: { command: 'npm publish' },
            status: 'error',
            resultPreview: 'Not now',
          },
          { id: 'x2', name: 'Edit', input: { file_path: '/home/dev/notes/a.md' } },
        ],
      }),
    ]);
    const result = await new RulesService(store, {
      now: () => NOW,
      home: '/home/dev',
      decisions: () => new Map([['x1', 'deny']]),
    }).compute('30d');
    expect(result.rows.map((r) => [r.key, r.denied, r.danger])).toEqual([
      ['Bash(npm publish:*)', 1, null],
      ['Edit(~/notes/**)', 0, 'outside'],
    ]);
  });

  it('reads nothing more once stopped', async () => {
    const { store } = fakeStore([snap('a', { commands: ['x'] })]);
    const rules = new RulesService(store, { now: () => NOW });
    rules.stop();
    await expect(rules.compute('30d')).rejects.toThrow('stopped');
  });
});
