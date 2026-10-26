import { describe, expect, it } from 'vitest';
import {
  holds,
  type PermissionEvent,
  type RuleProject,
  ruleRows,
  rulesWindowStart,
  type SessionEvents,
  type SettingsFile,
  scopeOf,
} from './permissions.js';

const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

const SHOP: RuleProject = { root: '/work/shop', name: 'shop' };
const BLOG: RuleProject = { root: '/work/blog', name: 'blog' };

function ev(key: string, min: number, o: Partial<PermissionEvent> = {}): PermissionEvent {
  return {
    key,
    tool: key.replace(/\(.*$/, ''),
    agent: 'claude-code',
    answer: 'allowed',
    at: iso(min),
    toolCallId: `t${min}`,
    danger: null,
    ...o,
  };
}

const session = (sessionId: string, project: RuleProject, events: PermissionEvent[]) =>
  ({ sessionId, project, events }) satisfies SessionEvents;

/** `n` allowed calls of `key`, a minute apart from `from`. */
const times = (key: string, n: number, from = 0, o: Partial<PermissionEvent> = {}) =>
  Array.from({ length: n }, (_, i) => ev(key, from + i, o));

describe('the rule table', () => {
  const sessions = [
    session('s1', SHOP, [
      ...times('Bash(npm test:*)', 3, 10),
      ev('Bash(git push:*)', 20, { answer: 'denied', danger: 'force-push' }),
    ]),
    session('s2', BLOG, [...times('Bash(npm test:*)', 2, 30), ev('Edit(src/**)', 5)]),
  ];

  it('counts each rule: asked, allowed, denied, in how many sessions and when last, the most asked first', () => {
    const rows = ruleRows(sessions, { from: null, settings: [] });
    expect(
      rows.map((r) => [r.key, r.asked, r.allowed, r.denied, r.sessions, r.lastAsked, r.danger]),
    ).toEqual([
      ['Bash(npm test:*)', 5, 5, 0, 2, iso(31), null],
      ['Bash(git push:*)', 1, 0, 1, 1, iso(20), 'force-push'],
      ['Edit(src/**)', 1, 1, 0, 1, iso(5), null],
    ]);
  });

  it('counts each project a rule was asked in on its own, the most asked first', () => {
    const [npm] = ruleRows(sessions, { from: null, settings: [] });
    expect(npm?.projects).toEqual([
      { ...SHOP, asked: 3, allowed: 3, denied: 0, lastAsked: iso(12) },
      { ...BLOG, asked: 2, allowed: 2, denied: 0, lastAsked: iso(31) },
    ]);
  });

  it('counts only what was asked since the window began', () => {
    const rows = ruleRows(sessions, { from: Date.parse(iso(12)), settings: [] });
    expect(rows.map((r) => [r.key, r.asked])).toEqual([
      ['Bash(npm test:*)', 3],
      ['Bash(git push:*)', 1],
    ]);
  });

  it('keeps the gravest harm any of its calls showed', () => {
    const rows = ruleRows(
      [
        session('s1', SHOP, [
          ev('Bash(curl:*)', 1),
          ev('Bash(curl:*)', 2, { danger: 'pipe-to-shell' }),
          ev('Bash(curl:*)', 3),
        ]),
      ],
      { from: null, settings: [] },
    );
    expect(rows[0]?.danger).toBe('pipe-to-shell');
    const reads = ruleRows(
      [
        session('s1', SHOP, [
          ev('Read(~/x/**)', 1, { danger: 'outside' }),
          ev('Read(~/x/**)', 2, { danger: 'secrets' }),
        ]),
      ],
      { from: null, settings: [] },
    );
    expect(reads[0]?.danger).toBe('secrets');
    const kills = ruleRows(
      [
        session('s1', SHOP, [
          ev('Bash(x:*)', 1, { danger: 'kill' }),
          ev('Bash(x:*)', 2, { danger: 'delete' }),
        ]),
      ],
      { from: null, settings: [] },
    );
    expect(kills[0]?.danger).toBe('delete');
  });
});

describe('whether a settings rule holds a key', () => {
  it.each([
    ['Bash(npm test:*)', 'Bash(npm test:*)', true],
    ['Bash(npm:*)', 'Bash(npm test:*)', true],
    ['Bash(npm *)', 'Bash(npm test:*)', true],
    ['Bash(np:*)', 'Bash(npm test:*)', false],
    ['Bash(npm test)', 'Bash(npm test:*)', false],
    ['Bash(npm run build:*)', 'Bash(npm run:*)', false],
    ['Bash', 'Bash(rm:*)', true],
    ['Bash(*)', 'Bash(rm:*)', true],
    ['Edit(src/**)', 'Edit(src/**)', true],
    ['Edit(./src/**)', 'Edit(src/**)', true],
    ['Edit(/src/**)', 'Edit(src/**)', true],
    ['Edit(**)', 'Edit(README.md)', true],
    ['Edit(**)', 'Edit(~/notes/**)', false],
    ['Edit(~/**)', 'Edit(~/notes/**)', true],
    ['Read(//tmp/**)', 'Read(//tmp/build/**)', true],
    ['Edit', 'Edit(//tmp/build/**)', true],
    ['Read(//tmp/**)', 'Edit(//tmp/build/**)', false],
    ['WebFetch', 'WebFetch(domain:docs.example.dev)', true],
    ['WebFetch(domain:docs.example.dev)', 'WebFetch(domain:docs.example.dev)', true],
    ['WebFetch(domain:example.dev)', 'WebFetch(domain:docs.example.dev)', false],
    ['mcp__tracker', 'mcp__tracker__create_issue', true],
    ['mcp__tracker__*', 'mcp__tracker__create_issue', true],
    ['mcp__other', 'mcp__tracker__create_issue', false],
    ['WebSearch', 'WebSearch', true],
  ])('%s holds %s: %s', (rule, key, want) => {
    expect(holds(rule, key)).toBe(want);
  });
});

describe('the settings that hold a rule, and the rules to suggest', () => {
  const GLOBAL: SettingsFile = {
    path: '/home/dev/.claude/settings.json',
    scope: 'global',
    root: null,
    allow: ['Bash(npm:*)'],
    deny: [],
  };
  const SHOP_LOCAL: SettingsFile = {
    path: '/work/shop/.claude/settings.local.json',
    scope: 'project',
    root: '/work/shop',
    allow: ['Edit(src/**)', 'WebSearch'],
    deny: ['Bash(git push:*)'],
  };
  const rowsOf = (events: SessionEvents[], settings: SettingsFile[] = []) =>
    Object.fromEntries(ruleRows(events, { from: null, settings }).map((r) => [r.key, r]));

  it('names every settings file and list that holds a rule', () => {
    const rows = rowsOf(
      [
        session('s1', SHOP, [
          ev('Bash(npm test:*)', 1),
          ev('Edit(src/**)', 2),
          ev('Bash(git push:*)', 3),
          ev('Bash(make:*)', 4),
        ]),
      ],
      [GLOBAL, SHOP_LOCAL],
    );
    expect(rows['Bash(npm test:*)']?.inSettings).toEqual([
      { path: GLOBAL.path, scope: 'global', root: null, list: 'allow', rule: 'Bash(npm:*)' },
    ]);
    expect(rows['Edit(src/**)']?.inSettings).toEqual([
      {
        path: SHOP_LOCAL.path,
        scope: 'project',
        root: '/work/shop',
        list: 'allow',
        rule: 'Edit(src/**)',
      },
    ]);
    expect(rows['Bash(git push:*)']?.inSettings).toEqual([
      {
        path: SHOP_LOCAL.path,
        scope: 'project',
        root: '/work/shop',
        list: 'deny',
        rule: 'Bash(git push:*)',
      },
    ]);
    expect(rows['Bash(make:*)']?.inSettings).toEqual([]);
  });

  it('suggests a rule asked five times and always allowed, and no rule asked fewer', () => {
    const rows = rowsOf([
      session('s1', SHOP, [...times('Bash(make test:*)', 3), ...times('Bash(make lint:*)', 4)]),
      session('s2', SHOP, times('Bash(make test:*)', 2, 10)),
    ]);
    expect(rows['Bash(make test:*)']?.suggested).toBe(true);
    expect(rows['Bash(make lint:*)']?.suggested).toBe(false);
  });

  it('suggests no rule asked in one session only, however often: a habit spans sessions', () => {
    const rows = rowsOf([session('s1', SHOP, times('Bash(make build:*)', 9))]);
    expect(rows['Bash(make build:*)']?.suggested).toBe(false);
  });

  it('suggests none that was ever denied, that may do harm, or that is Codex’s', () => {
    const rows = rowsOf([
      session('s1', SHOP, [
        ...times('Bash(make test:*)', 6),
        ev('Bash(make test:*)', 9, { answer: 'denied' }),
        ...times('Bash(rm:*)', 9, 20, { danger: 'delete' }),
        ...times('prefix_rule(pattern=["npm", "test"])', 7, 40, {
          agent: 'codex',
          tool: 'prefix_rule',
        }),
      ]),
    ]);
    expect(rows['Bash(make test:*)']?.suggested).toBe(false);
    expect(rows['Bash(rm:*)']?.suggested).toBe(false);
    expect(rows['prefix_rule(pattern=["npm", "test"])']?.suggested).toBe(false);
  });

  it('suggests none a rule already allows where it would go, or any rule denies', () => {
    const OTHER: SettingsFile = {
      ...SHOP_LOCAL,
      path: '/work/blog/.claude/settings.json',
      root: '/work/blog',
    };
    const rows = rowsOf(
      [
        session('s1', SHOP, [
          ...times('Bash(npm test:*)', 5),
          ...times('Edit(src/**)', 5, 10),
          ...times('WebSearch', 5, 20),
          ...times('Bash(git push:*)', 5, 30),
        ]),
        session('s2', BLOG, times('Edit(docs/**)', 5, 40)),
      ],
      [GLOBAL, SHOP_LOCAL, { ...OTHER, allow: ['Edit(**)'], deny: [] }],
    );
    // Held globally; held in its project; denied; held in its project (blog's); then one held
    // only in another project's file: still suggested for its own.
    expect(rows['Bash(npm test:*)']?.suggested).toBe(false);
    expect(rows['Edit(src/**)']?.suggested).toBe(false);
    expect(rows['Bash(git push:*)']?.suggested).toBe(false);
    expect(rows['Edit(docs/**)']?.suggested).toBe(false);
    expect(
      rowsOf(
        [
          session('s2', SHOP, times('Edit(docs/**)', 3, 40)),
          session('s3', SHOP, times('Edit(docs/**)', 2, 50)),
        ],
        [{ ...OTHER, allow: ['Edit(**)'], deny: [] }],
      )['Edit(docs/**)']?.suggested,
    ).toBe(true);
  });

  it('puts a rule asked in two projects in your settings, and one asked in one in that project’s', () => {
    const [both, one] = ruleRows(
      [
        session('s1', SHOP, [...times('Bash(make:*)', 3), ...times('Bash(make test:*)', 2, 10)]),
        session('s2', BLOG, times('Bash(make:*)', 3, 20)),
      ],
      { from: null, settings: [] },
    );
    expect(both && scopeOf(both)).toEqual({ scope: 'global' });
    expect(one && scopeOf(one)).toEqual({ scope: 'project', root: '/work/shop', name: 'shop' });
    expect(
      scopeOf({
        projects: [{ root: null, name: '?', asked: 1, allowed: 1, denied: 0, lastAsked: iso(0) }],
      }),
    ).toEqual({
      scope: 'global',
    });
  });
});

describe('the windows', () => {
  it('begin 7 and 30 days before now, and all has no beginning', () => {
    const now = Date.parse('2026-10-26T12:00:00.000Z');
    expect(rulesWindowStart('7d', now)).toBe(Date.parse('2026-10-19T12:00:00.000Z'));
    expect(rulesWindowStart('30d', now)).toBe(Date.parse('2026-09-26T12:00:00.000Z'));
    expect(rulesWindowStart('all', now)).toBeNull();
  });
});
