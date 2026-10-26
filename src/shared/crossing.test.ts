import { describe, expect, it } from 'vitest';
import type { LineChange, RepoIdentity, ToolCall } from '../core/model.js';
import {
  type CrossingSession,
  changesOf,
  crossings,
  type EditMark,
  type FileOps,
  fileOpsOf,
  MAX_MARKS,
  MAX_PATHS,
  spanText,
} from './crossing.js';

const CWD = '/w/glassbox';
const T0 = Date.UTC(2026, 9, 26, 9, 0, 0);

let serial = 0;
/** A finished call of the main agent, a second after the one before it. */
function call(name: string, input: unknown, over: Partial<ToolCall> = {}): ToolCall {
  serial++;
  const at = new Date(T0 + serial * 1000).toISOString();
  return {
    id: `t_${serial}`,
    agentId: 'main',
    requestId: 'r1',
    name,
    input,
    status: 'complete',
    startedAt: at,
    endedAt: at,
    durationMs: 0,
    resultPreview: null,
    hasFullResult: false,
    spawned: null,
    ...over,
  };
}

const edit = (path: string, lineChanges?: LineChange[], over: Partial<ToolCall> = {}) =>
  call('Edit', { file_path: path, old_string: 'a', new_string: 'b' }, { lineChanges, ...over });

describe('changesOf', () => {
  it('turns a call into changes of files: created and deleted whole, an edit by the lines it recorded', () => {
    const lines = (t: ToolCall) => changesOf(t, CWD, 0).map((c) => [c.path, c.verb, c.mark[1]]);
    expect(lines(call('Write', { file_path: 'src/new.ts', content: 'x' }))).toEqual([
      ['/w/glassbox/src/new.ts', 'created', 'all'],
    ]);
    expect(lines(edit('src/a.ts', [[41, 1, 3]]))).toEqual([
      ['/w/glassbox/src/a.ts', 'edited', [[41, 1, 3]]],
    ]);
    // An edit's input does not say where it landed.
    expect(lines(edit('src/a.ts'))).toEqual([['/w/glassbox/src/a.ts', 'edited', null]]);
    expect(lines(call('Delete', { path: 'old.ts' }))).toEqual([
      ['/w/glassbox/old.ts', 'deleted', 'all'],
    ]);
    const over = { resultPreview: 'The file has been updated.' };
    expect(
      lines(
        call('Write', { file_path: 'a.ts', content: 'x' }, { ...over, lineChanges: [[2, 1, 1]] }),
      ),
    ).toEqual([['/w/glassbox/a.ts', 'edited', [[2, 1, 1]]]]);
    // A Write over a file, its lines not recorded: the whole file.
    expect(lines(call('Write', { file_path: 'a.ts', content: 'x' }, over))).toEqual([
      ['/w/glassbox/a.ts', 'edited', 'all'],
    ]);
    const patch = [
      '*** Begin Patch',
      '*** Add File: notes/new.md',
      '+# New',
      '*** Update File: src/b.ts',
      '@@ export function b(',
      '-  return a;',
      '+  return b;',
      '*** Delete File: old.txt',
      '*** End Patch',
    ].join('\n');
    // A patch's sections carry no line numbers.
    expect(lines(call('apply_patch', { input: patch }))).toEqual([
      ['/w/glassbox/notes/new.md', 'created', 'all'],
      ['/w/glassbox/src/b.ts', 'edited', null],
      ['/w/glassbox/old.txt', 'deleted', 'all'],
    ]);
    expect(lines(call('Read', { file_path: 'src/a.ts' }))).toEqual([]);
    expect(lines(call('Grep', { pattern: 'x', path: 'src' }))).toEqual([]);
  });

  it('times a change by when its call ended, else began, else the fallback', () => {
    const t = edit('a.ts', undefined, {
      startedAt: new Date(T0).toISOString(),
      endedAt: new Date(T0 + 5000).toISOString(),
    });
    expect(changesOf(t, CWD, 0)[0]?.mark[0]).toBe(T0 + 5000);
    expect(changesOf({ ...t, endedAt: null }, CWD, 0)[0]?.mark[0]).toBe(T0);
    expect(changesOf({ ...t, endedAt: null, startedAt: null }, CWD, 7)[0]?.mark[0]).toBe(7);
  });

  it('leaves out a failed call and a running one: neither is known to have changed the file', () => {
    expect(changesOf(edit('a.ts', [[1, 1, 1]], { status: 'error' }), CWD, 0)).toEqual([]);
    expect(changesOf(edit('a.ts', [[1, 1, 1]], { status: 'running' }), CWD, 0)).toEqual([]);
    expect(changesOf(edit('a.ts', [[1, 1, 1]], { status: 'unknown' }), CWD, 0)).toHaveLength(1);
  });
});

describe('fileOpsOf', () => {
  it('adds a session’s changes up by path, the asked agents’ only, its marks in time order', () => {
    const first = edit('src/a.ts', [[1, 1, 1]]);
    const second = edit('src/a.ts', [[9, 0, 2]]);
    const created = call('Write', { file_path: 'src/b.ts', content: 'x' });
    const other = edit('src/c.ts', undefined, { agentId: 'sub' });
    const ops = fileOpsOf([second, created, first, other], CWD, new Set(['main']), 0);
    expect(ops?.more).toBe(0);
    expect(ops?.paths).toEqual([
      {
        path: '/w/glassbox/src/b.ts',
        edited: 0,
        created: 1,
        deleted: 0,
        first: Date.parse(created.endedAt as string),
        last: Date.parse(created.endedAt as string),
        marks: [[Date.parse(created.endedAt as string), 'all']],
      },
      {
        path: '/w/glassbox/src/a.ts',
        edited: 2,
        created: 0,
        deleted: 0,
        first: Date.parse(first.endedAt as string),
        last: Date.parse(second.endedAt as string),
        marks: [
          [Date.parse(first.endedAt as string), [[1, 1, 1]]],
          [Date.parse(second.endedAt as string), [[9, 0, 2]]],
        ],
      },
    ]);
  });

  it('keeps the 400 most recently changed paths, and says how many it left out', () => {
    const calls = Array.from({ length: MAX_PATHS + 1 }, (_, i) => edit(`f${i}.ts`));
    const ops = fileOpsOf(calls, CWD, new Set(['main']), 0);
    expect(MAX_PATHS).toBe(400);
    expect(ops?.paths).toHaveLength(400);
    expect(ops?.more).toBe(1);
    // The oldest went.
    expect(ops?.paths.some((p) => p.path === '/w/glassbox/f0.ts')).toBe(false);
  });

  it('keeps 64 changes of a path, then one that says the rest are not known', () => {
    const calls = Array.from({ length: MAX_MARKS + 2 }, (_, i) => edit('a.ts', [[i + 1, 1, 1]]));
    const path = fileOpsOf(calls, CWD, new Set(['main']), 0)?.paths[0];
    expect(MAX_MARKS).toBe(64);
    expect(path?.edited).toBe(66);
    expect(path?.marks).toHaveLength(65);
    expect(path?.marks.at(-1)).toEqual([Date.parse(calls[64]?.endedAt as string), null]);
  });

  it('is nothing for a session that changed no file', () => {
    expect(fileOpsOf([call('Read', { file_path: 'a.ts' })], CWD, new Set(['main']), 0)).toBe(
      undefined,
    );
  });
});

const ROOT = '/w/glassbox';
const repo = (dir: string, root = ROOT): RepoIdentity => ({
  root,
  dir,
  name: root.split(/[\\/]/).at(-1) as string,
});

/** Changes of paths, each its marks; counts as that many edits. */
function ops(...paths: [string, EditMark[]][]): FileOps {
  return {
    paths: paths.map(([path, marks]) => ({
      path,
      edited: marks.length,
      created: 0,
      deleted: 0,
      first: marks[0]?.[0] ?? 0,
      last: marks.at(-1)?.[0] ?? 0,
      marks,
    })),
    more: 0,
  };
}

const at = (n: number) => T0 + n * 60_000;
const session = (id: string, dir: string, files?: FileOps, root = ROOT): CrossingSession => ({
  id,
  repo: repo(dir, root),
  files,
});

describe('crossings', () => {
  it('finds the files two working trees of one repository changed, a side for each tree', () => {
    const r = crossings([
      session('s1', ROOT, ops([`${ROOT}/src/a.ts`, [[at(1), null]]])),
      session(
        's2',
        '/w/trees/weever',
        ops(
          [
            '/w/trees/weever/src/a.ts',
            [
              [at(2), null],
              [at(3), null],
            ],
          ],
          ['/w/trees/weever/src/b.ts', [[at(4), null]]],
        ),
      ),
      session('s3', '/w/trees/weever', ops(['/w/trees/weever/src/a.ts', [[at(5), null]]])),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ root: ROOT, name: 'glassbox', cut: 0 });
    expect(r[0]?.trees).toEqual([
      { dir: ROOT, name: 'glassbox', main: true, sessions: 1 },
      { dir: '/w/trees/weever', name: 'weever', main: false, sessions: 2 },
    ]);
    const [path] = r[0]?.paths ?? [];
    expect(r[0]?.paths).toHaveLength(1);
    expect(path?.path).toBe('src/a.ts');
    expect(path?.last).toBe(at(5));
    expect(
      path?.sides.map((s) => [s.tree.name, s.sessions, s.edits, s.first, s.last, s.known]),
    ).toEqual([
      ['glassbox', [{ id: 's1', path: `${ROOT}/src/a.ts` }], 1, at(1), at(1), false],
      [
        'weever',
        [
          { id: 's2', path: '/w/trees/weever/src/a.ts' },
          { id: 's3', path: '/w/trees/weever/src/a.ts' },
        ],
        3,
        at(2),
        at(5),
        false,
      ],
    ]);
  });

  it('never counts two sessions of one tree as crossing; a repository with one tree is left out', () => {
    expect(
      crossings([
        session('s1', ROOT, ops([`${ROOT}/a.ts`, [[at(1), null]]])),
        session('s2', ROOT, ops([`${ROOT}/a.ts`, [[at(2), null]]])),
      ]),
    ).toEqual([]);
    // Two trees at work, no file in common: listed, with nothing crossing.
    const apart = crossings([
      session('s1', ROOT, ops([`${ROOT}/a.ts`, [[at(1), null]]])),
      session('s2', '/w/trees/weever'),
    ]);
    expect(apart.map((c) => [c.name, c.trees.length, c.paths.length])).toEqual([
      ['glassbox', 2, 0],
    ]);
  });

  it('compares paths relative to each tree, whatever the separators', () => {
    const r = crossings([
      session('s1', ROOT, ops([`${ROOT}/web/src/a.ts`, [[at(1), null]]])),
      session('s2', '/w/trees/weever', ops(['/w/trees/weever/web/src/a.ts', [[at(2), null]]])),
    ]);
    expect(r[0]?.paths.map((p) => p.path)).toEqual(['web/src/a.ts']);
    const win = crossings([
      session(
        's1',
        'C:\\w\\glassbox',
        ops(['C:\\w\\glassbox\\src\\a.ts', [[at(1), null]]]),
        'C:\\w\\glassbox',
      ),
      session(
        's2',
        'C:\\w\\weever',
        ops(['C:\\w\\weever\\src\\a.ts', [[at(2), null]]]),
        'C:\\w\\glassbox',
      ),
    ]);
    expect(win[0]?.paths.map((p) => p.path)).toEqual(['src/a.ts']);
  });

  it('never crosses two repositories of one name, nor a session without a repository', () => {
    const change = (dir: string) => ops([`${dir}/src/x.ts`, [[at(1), null]]]);
    expect(
      crossings([
        session('s1', '/a/api', change('/a/api'), '/a/api'),
        session('s2', '/b/api', change('/b/api'), '/b/api'),
        { id: 's3', repo: null, files: change('/w/glassbox') },
        { id: 's4', files: change('/w/glassbox') },
      ]),
    ).toEqual([]);
  });

  it('leaves out a change outside the session’s own tree: it is not that tree’s', () => {
    const r = crossings([
      session('s1', ROOT, ops([`${ROOT}/src/a.ts`, [[at(1), null]]])),
      // A worktree's session editing the main tree's file by its whole path, as deep as its own.
      session('s2', '/w/weever', ops([`${ROOT}/src/a.ts`, [[at(2), null]]])),
    ]);
    expect(r[0]?.trees.map((t) => t.name)).toEqual(['glassbox', 'weever']);
    expect(r[0]?.paths).toEqual([]);
  });

  it('says whether the trees changed the same lines: overlapping, touching, apart, unknown, whole', () => {
    const pair = (a: EditMark['1'], b: EditMark['1']) =>
      crossings([
        session('s1', ROOT, ops([`${ROOT}/a.ts`, [[at(1), a]]])),
        session('s2', '/w/trees/weever', ops(['/w/trees/weever/a.ts', [[at(2), b]]])),
      ])[0]?.paths[0];
    const same = pair([[41, 1, 3]], [[40, 2, 2]]);
    expect(same?.overlap).toBe(true);
    expect(same?.sides.map((s) => [s.lines, s.hot])).toEqual([
      [[{ from: 41, to: 41, hot: true }], true],
      [[{ from: 40, to: 41, hot: true }], true],
    ]);
    // Neighbouring lines conflict in a merge as the same ones do.
    expect(pair([[10, 1, 1]], [[11, 1, 1]])?.overlap).toBe(true);
    const apart = pair([[1, 1, 1]], [[50, 1, 1]]);
    expect(apart?.overlap).toBe(false);
    expect(apart?.sides.map((s) => [s.lines, s.hot, s.known])).toEqual([
      [[{ from: 1, to: 1, hot: false }], false, true],
      [[{ from: 50, to: 50, hot: false }], false, true],
    ]);
    expect(pair([[1, 1, 1]], null)?.overlap).toBe(null);
    const whole = pair('all', [[50, 1, 1]]);
    expect(whole?.overlap).toBe(true);
    expect(whole?.sides.map((s) => [s.lines, s.hot])).toEqual([
      ['all', true],
      [[{ from: 50, to: 50, hot: true }], true],
    ]);
  });

  it('knows an overlap from the lines it knows, even when a later change’s are not', () => {
    const r = crossings([
      session(
        's1',
        ROOT,
        ops([
          `${ROOT}/a.ts`,
          [
            [at(1), [[5, 1, 1]]],
            [at(3), null],
          ],
        ]),
      ),
      session('s2', '/w/trees/weever', ops(['/w/trees/weever/a.ts', [[at(2), [[5, 1, 1]]]]])),
    ]);
    expect(r[0]?.paths[0]?.overlap).toBe(true);
    expect(r[0]?.paths[0]?.sides[0]?.known).toBe(false);
  });

  it('places a tree’s later changes in the file as the tree found it, whichever session made them', () => {
    // Twenty lines put in at the top, then line 121, which was line 101 before them; the two
    // changes made by two sessions of the tree, listed out of order.
    const main = [
      session('s1', ROOT, ops([`${ROOT}/a.ts`, [[at(5), [[121, 1, 1]]]]])),
      session('s0', ROOT, ops([`${ROOT}/a.ts`, [[at(1), [[1, 0, 20]]]]])),
    ];
    const against = (b: LineChange[]) =>
      crossings([
        ...main,
        session('s2', '/w/trees/weever', ops(['/w/trees/weever/a.ts', [[at(2), b]]])),
      ])[0]?.paths[0];
    const hit = against([[101, 1, 1]]);
    expect(hit?.overlap).toBe(true);
    expect(hit?.sides[0]?.lines).toEqual([
      { from: 1, to: 0, hot: false },
      { from: 101, to: 101, hot: true },
    ]);
    expect(against([[121, 1, 1]])?.overlap).toBe(false);
    // Lines this tree put in itself and changed again stay where it put them.
    const again = crossings([
      session(
        's0',
        ROOT,
        ops([
          `${ROOT}/a.ts`,
          [
            [at(1), [[10, 0, 5]]],
            [at(2), [[12, 1, 3]]],
          ],
        ]),
      ),
      session('s2', '/w/trees/weever', ops(['/w/trees/weever/a.ts', [[at(3), [[40, 1, 1]]]]])),
    ])[0]?.paths[0];
    expect(again?.sides[0]?.lines).toEqual([{ from: 10, to: 9, hot: false }]);
  });

  it('lists the same lines first, then the unknown, then those apart, the latest first', () => {
    const tree = (dir: string, b: number) =>
      session(
        dir,
        dir,
        ops(
          [`${dir}/apart.ts`, [[at(9 + b), [[b * 100, 1, 1]]]]],
          [`${dir}/unknown.ts`, [[at(1 + b), null]]],
          [`${dir}/same.ts`, [[at(2 + b), [[3, 1, 1]]]]],
          [`${dir}/same-later.ts`, [[at(20 + b), [[3, 1, 1]]]]],
        ),
      );
    const r = crossings([tree(ROOT, 1), tree('/w/trees/weever', 2)]);
    expect(r[0]?.paths.map((p) => p.path)).toEqual([
      'same-later.ts',
      'same.ts',
      'unknown.ts',
      'apart.ts',
    ]);
  });

  it('counts the sessions whose files were cut short', () => {
    const cut = { ...ops([`${ROOT}/a.ts`, [[at(1), null]]]), more: 3 };
    expect(crossings([session('s1', ROOT, cut), session('s2', '/w/trees/weever')])[0]?.cut).toBe(1);
  });
});

describe('spanText', () => {
  it('writes a run of lines, one line, or where lines went in', () => {
    expect(spanText({ from: 40, to: 43, hot: false })).toBe('40–43');
    expect(spanText({ from: 41, to: 41, hot: false })).toBe('41');
    expect(spanText({ from: 12, to: 11, hot: false })).toBe('12');
  });
});
