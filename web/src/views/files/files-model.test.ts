import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../../src/core/model.js';
import { demoRepo } from '../../../../src/server/week-demo.js';
import type { OpenSession } from '../../data/store';
import { subtreeIds } from '../../lib/agents';
import { demoOpen } from '../../test/demo';
import { demoWeek } from '../../test/week';
import {
  buildFiles,
  crossingKeys,
  type FileVerb,
  filterFiles,
  lineDiff,
  patchSections,
  resolvePath,
  shownPath,
  touchesOf,
} from './files-model';

const CWD = '/Users/demo/Dev/glassbox';
const MAIN: ReadonlySet<string> = new Set(['main']);

let serial = 0;
const at = (sec: number) => new Date(Date.UTC(2026, 9, 23, 9, 20, sec)).toISOString();

/** A finished tool call of the main agent, one second after the one before it. */
function call(name: string, input: unknown, over: Partial<ToolCall> = {}): ToolCall {
  serial++;
  return {
    id: `t_${serial}`,
    agentId: 'main',
    requestId: 'req_m1',
    name,
    input,
    status: 'complete',
    startedAt: at(serial),
    endedAt: at(serial),
    durationMs: 100,
    resultPreview: null,
    hasFullResult: false,
    spawned: null,
    ...over,
  };
}

/** The demo session with only these tool calls, in this working directory. */
function openWith(tools: ToolCall[], cwd: string | null = CWD): OpenSession {
  const open = demoOpen();
  return {
    ...open,
    session: { ...open.session, cwd },
    toolCalls: new Map(tools.map((t) => [t.id, t])),
  };
}

const PATCH = [
  '*** Begin Patch',
  '*** Add File: notes/new.md',
  '+# New',
  '+First line',
  '*** Update File: src/server/store.ts',
  '*** Move to: src/server/sessions.ts',
  '@@ export function sortSessions(',
  '-  return a;',
  '+  return b;',
  '*** Delete File: old.txt',
  '*** End Patch',
].join('\n');

describe('touchesOf', () => {
  describe('Claude Code', () => {
    it('reads a file, with the lines an offset and limit name', () => {
      expect(touchesOf(call('Read', { file_path: '/r/a.ts' }))).toEqual([
        { path: '/r/a.ts', verb: 'read', lines: null, detail: { kind: 'none' } },
      ]);
      expect(touchesOf(call('Read', { file_path: '/r/a.ts', offset: 36, limit: 30 }))).toEqual([
        { path: '/r/a.ts', verb: 'read', lines: '36-65', detail: { kind: 'none' } },
      ]);
      expect(touchesOf(call('Read', { file_path: '/r/a.ts', offset: 10 }))[0]?.lines).toBe('10');
      expect(touchesOf(call('NotebookRead', { notebook_path: '/r/n.ipynb' }))[0]?.verb).toBe(
        'read',
      );
    });

    it('edits a file by one replacement, or several, in order', () => {
      expect(
        touchesOf(call('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' })),
      ).toEqual([
        {
          path: '/r/a.ts',
          verb: 'edited',
          lines: null,
          detail: { kind: 'replace', edits: [{ before: 'a', after: 'b', all: false }] },
        },
      ]);
      const multi = call('MultiEdit', {
        file_path: '/r/a.ts',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd', replace_all: true },
        ],
      });
      expect(touchesOf(multi)[0]?.detail).toEqual({
        kind: 'replace',
        edits: [
          { before: 'a', after: 'b', all: false },
          { before: 'c', after: 'd', all: true },
        ],
      });
    });

    it('says where an edit landed, as its result recorded it, in the file as the edit left it', () => {
      const edit = (lineChanges: [number, number, number][]) =>
        touchesOf(
          call('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }, { lineChanges }),
        )[0]?.lines;
      expect(edit([[41, 1, 3]])).toBe('41-43');
      // The second change sits three lines lower once the first put three in.
      expect(
        edit([
          [36, 0, 3],
          [41, 1, 3],
        ]),
      ).toBe('36-38, 44-46');
      // Lines only removed: where they were.
      expect(edit([[5, 2, 0]])).toBe('5');
      expect(
        edit([
          [1, 0, 1],
          [10, 1, 1],
          [20, 1, 1],
          [30, 1, 1],
        ]),
      ).toBe('1, 11, 21, …');
      const over = call(
        'Write',
        { file_path: '/r/a.ts', content: 'x' },
        { resultPreview: 'The file /r/a.ts has been updated.', lineChanges: [[2, 1, 1]] },
      );
      expect(touchesOf(over)[0]?.lines).toBe('2');
      // A patch names its own files: a call's line changes are never its sections'.
      const patch = call('apply_patch', { input: PATCH }, { lineChanges: [[1, 1, 1]] });
      expect(touchesOf(patch).map((t) => t.lines)).toEqual([null, null, null]);
    });

    it('creates a file with Write, or edits it when the result says the file was there', () => {
      const created = call('Write', { file_path: '/r/new.ts', content: 'export {};\n' });
      expect(touchesOf(created)).toEqual([
        {
          path: '/r/new.ts',
          verb: 'created',
          lines: null,
          detail: { kind: 'write', content: 'export {};\n' },
        },
      ]);
      const over = call(
        'Write',
        { file_path: '/r/a.ts', content: 'x' },
        { resultPreview: 'The file /r/a.ts has been updated. Here is the result of running cat' },
      );
      expect(touchesOf(over)[0]?.verb).toBe('edited');
    });

    it('edits a notebook cell', () => {
      const tool = call('NotebookEdit', {
        notebook_path: '/r/n.ipynb',
        cell_id: 'cell-3',
        cell_type: 'code',
        edit_mode: 'replace',
        new_source: 'print(1)',
      });
      expect(touchesOf(tool)).toEqual([
        {
          path: '/r/n.ipynb',
          verb: 'edited',
          lines: null,
          detail: {
            kind: 'notebook',
            cellId: 'cell-3',
            mode: 'replace',
            cellType: 'code',
            source: 'print(1)',
          },
        },
      ]);
    });

    it('counts a search only by the path it was given, never its matches', () => {
      expect(touchesOf(call('Grep', { pattern: 'x', path: '/r/src' }))).toEqual([
        { path: '/r/src', verb: 'searched', lines: null, detail: { kind: 'none' } },
      ]);
      expect(touchesOf(call('Glob', { pattern: '**/*.ts', path: '/r/web' }))[0]?.verb).toBe(
        'searched',
      );
      expect(touchesOf(call('Grep', { pattern: 'x' }))).toEqual([]);
      expect(touchesOf(call('Glob', { pattern: '**/*.ts' }))).toEqual([]);
    });

    it('never lists a shell command, a sub-agent, a web fetch or an MCP tool', () => {
      expect(touchesOf(call('Bash', { command: 'cat /r/a.ts' }))).toEqual([]);
      expect(touchesOf(call('Agent', { description: 'x', prompt: '/r/a.ts' }))).toEqual([]);
      expect(touchesOf(call('WebFetch', { url: 'https://example.com/a.ts' }))).toEqual([]);
      expect(touchesOf(call('mcp__fs__read', { path: '/r/a.ts' }))).toEqual([]);
      expect(touchesOf(call('Edit', 'not an object'))).toEqual([]);
      expect(touchesOf(call('Edit', { old_string: 'a', new_string: 'b' }))).toEqual([]);
    });
  });

  describe('Codex', () => {
    it('reads each file a patch adds, updates or deletes, with its own lines', () => {
      expect(touchesOf(call('apply_patch', PATCH))).toEqual([
        {
          path: 'notes/new.md',
          verb: 'created',
          lines: null,
          detail: { kind: 'patch', hunk: '+# New\n+First line' },
        },
        {
          path: 'src/server/store.ts',
          verb: 'edited',
          lines: null,
          detail: {
            kind: 'patch',
            hunk: '*** Move to: src/server/sessions.ts\n@@ export function sortSessions(\n-  return a;\n+  return b;',
          },
        },
        { path: 'old.txt', verb: 'deleted', lines: null, detail: { kind: 'patch', hunk: '' } },
      ]);
      expect(touchesOf(call('apply_patch', { input: PATCH }))).toHaveLength(3);
      expect(touchesOf(call('apply_patch', 'echo not a patch'))).toEqual([]);
    });

    it('reads a file and lists a directory', () => {
      expect(touchesOf(call('read_file', { file_path: '/r/a.ts' }))[0]?.verb).toBe('read');
      expect(touchesOf(call('list_dir', { dir_path: '/r/src' }))[0]?.verb).toBe('searched');
      expect(touchesOf(call('grep_files', { pattern: 'x', path: '/r' }))[0]?.verb).toBe('searched');
      expect(touchesOf(call('shell', { command: ['cat', '/r/a.ts'] }))).toEqual([]);
    });
  });

  describe('OpenCode', () => {
    it('reads, edits, multi-edits, writes, patches and searches by its own key names', () => {
      expect(touchesOf(call('read', { filePath: '/r/a.ts', offset: 10, limit: 5 }))).toEqual([
        { path: '/r/a.ts', verb: 'read', lines: '10-14', detail: { kind: 'none' } },
      ]);
      expect(
        touchesOf(
          call('edit', { filePath: '/r/a.ts', oldString: 'a', newString: 'b', replaceAll: true }),
        )[0]?.detail,
      ).toEqual({ kind: 'replace', edits: [{ before: 'a', after: 'b', all: true }] });
      expect(
        touchesOf(
          call('multiedit', {
            filePath: '/r/a.ts',
            edits: [
              { oldString: 'a', newString: 'b' },
              { oldString: 'c', newString: 'd' },
            ],
          }),
        )[0]?.detail,
      ).toMatchObject({ kind: 'replace', edits: [{ before: 'a' }, { before: 'c' }] });
      expect(touchesOf(call('write', { filePath: '/r/b.md', content: '# b' }))[0]).toMatchObject({
        verb: 'created',
        detail: { kind: 'write', content: '# b' },
      });
      expect(touchesOf(call('patch', { patchText: PATCH }))).toHaveLength(3);
      expect(touchesOf(call('grep', { pattern: 'x', path: '/r/notes' }))[0]?.verb).toBe('searched');
      expect(touchesOf(call('list', { path: '/r/src' }))[0]?.verb).toBe('searched');
    });

    it('reads arguments that arrived as JSON text, and skips text that is not JSON', () => {
      expect(touchesOf(call('read', '{"filePath":"/r/a.ts"}'))[0]?.path).toBe('/r/a.ts');
      expect(touchesOf(call('read', '{"filePath":"/r/a.ts","off'))).toEqual([]);
    });
  });

  describe('oh-my-pi', () => {
    it('reads and edits files by path, and never a web page or a glob', () => {
      expect(touchesOf(call('read', { path: '/r/a.ts', i: 'Reading' }))[0]?.verb).toBe('read');
      expect(touchesOf(call('read', { path: 'https://docs.rs/x', i: 'Docs' }))).toEqual([]);
      expect(
        touchesOf(call('edit', { path: '/r/a.ts', oldText: 'a', newText: 'b' }))[0]?.detail,
      ).toEqual({ kind: 'replace', edits: [{ before: 'a', after: 'b', all: false }] });
      expect(touchesOf(call('write', { path: '/r/b.md', content: 'b' }))[0]?.verb).toBe('created');
      expect(touchesOf(call('glob', { path: 'docs/**/*.md', i: 'Finding docs' }))).toEqual([]);
      expect(touchesOf(call('grep', { pattern: 'x', path: '/r/src' }))[0]?.verb).toBe('searched');
    });
  });

  describe('Grok', () => {
    it('reads, replaces, writes, lists and deletes by its own tools', () => {
      expect(touchesOf(call('read_file', { target_file: '/r/a.ts' }))[0]?.verb).toBe('read');
      expect(
        touchesOf(
          call('search_replace', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }),
        )[0],
      ).toMatchObject({ verb: 'edited', detail: { kind: 'replace' } });
      expect(
        touchesOf(call('StrReplace', { path: '/r/a.ts', old_string: 'a', new_string: 'b' }))[0]
          ?.verb,
      ).toBe('edited');
      expect(touchesOf(call('write_file', { file_path: '/r/b.md', content: 'b' }))[0]?.verb).toBe(
        'created',
      );
      expect(touchesOf(call('list_dir', { target_directory: '/r/src/' }))[0]?.verb).toBe(
        'searched',
      );
      expect(touchesOf(call('Delete', { path: '/r/old.txt' }))).toEqual([
        { path: '/r/old.txt', verb: 'deleted', lines: null, detail: { kind: 'none' } },
      ]);
      // An edit whose shape glassbox does not read still names its file.
      expect(touchesOf(call('hashline_edit', { file_path: '/r/a.ts', ops: [] }))).toEqual([
        { path: '/r/a.ts', verb: 'edited', lines: null, detail: { kind: 'none' } },
      ]);
    });
  });
});

describe('resolvePath and shownPath', () => {
  it('resolves a relative path against the cwd and shows a path inside it relative', () => {
    expect(resolvePath('src/a.ts', CWD)).toBe(`${CWD}/src/a.ts`);
    expect(resolvePath('./src//a.ts/', CWD)).toBe(`${CWD}/src/a.ts`);
    expect(resolvePath('src/a.ts', null)).toBe('src/a.ts');
    expect(shownPath(`${CWD}/src/server/store.ts`, CWD)).toEqual({
      path: 'src/server/store.ts',
      dir: 'src/server',
      name: 'store.ts',
      outside: false,
    });
    expect(shownPath(`${CWD}/README.md`, CWD)).toEqual({
      path: 'README.md',
      dir: '',
      name: 'README.md',
      outside: false,
    });
  });

  it('shows a path outside the cwd whole, with the home directory as "~"', () => {
    expect(shownPath('/Users/demo/.claude/CLAUDE.md', CWD)).toEqual({
      path: '~/.claude/CLAUDE.md',
      dir: '~/.claude',
      name: 'CLAUDE.md',
      outside: true,
    });
    expect(shownPath('/home/demo/notes.md', '/home/demo/work')).toMatchObject({
      path: '~/notes.md',
      dir: '~',
    });
    expect(shownPath('/etc/hosts', CWD)).toEqual({
      path: '/etc/hosts',
      dir: '/etc',
      name: 'hosts',
      outside: true,
    });
    expect(shownPath('/hosts', CWD)).toMatchObject({ dir: '/', name: 'hosts' });
    expect(resolvePath('~/notes.md', CWD)).toBe('/Users/demo/notes.md');
  });

  it('keeps a Windows path on its own separators', () => {
    const cwd = 'C:\\Users\\demo\\proj';
    expect(resolvePath('src\\a.ts', cwd)).toBe('C:\\Users\\demo\\proj\\src\\a.ts');
    expect(shownPath('C:\\Users\\demo\\proj\\src\\a.ts', cwd)).toEqual({
      path: 'src\\a.ts',
      dir: 'src',
      name: 'a.ts',
      outside: false,
    });
    expect(shownPath('C:\\Users\\demo\\other\\b.ts', cwd)).toMatchObject({
      path: '~\\other\\b.ts',
      dir: '~\\other',
    });
  });
});

describe('patchSections', () => {
  it('splits a patch into its files, keeping a move with the file it renames', () => {
    expect(patchSections(PATCH).map((s) => [s.verb, s.path])).toEqual([
      ['created', 'notes/new.md'],
      ['edited', 'src/server/store.ts'],
      ['deleted', 'old.txt'],
    ]);
    expect(patchSections('*** Begin Patch\n*** End Patch')).toEqual([]);
    expect(patchSections('')).toEqual([]);
  });
});

describe('buildFiles', () => {
  it('lists one row per file, grouped by directory inside the cwd, then the paths outside it', () => {
    const files = buildFiles(
      openWith([
        call('Read', { file_path: `${CWD}/web/src/App.tsx` }),
        call('Read', { file_path: '/Users/demo/.claude/CLAUDE.md' }),
        call('Edit', { file_path: `${CWD}/src/server/store.ts`, old_string: 'a', new_string: 'b' }),
        call('Read', { file_path: `${CWD}/README.md` }),
        call('Write', { file_path: `${CWD}/src/server/store.test.ts`, content: '' }),
        call('Grep', { pattern: 'x', path: 'src' }),
        call('Read', { file_path: '/etc/hosts' }),
      ]),
      MAIN,
    );
    expect(files.groups.map((g) => [g.dir, g.outside, g.rows.map((r) => r.name)])).toEqual([
      ['', false, ['README.md', 'src']],
      ['src/server', false, ['store.test.ts', 'store.ts']],
      ['web/src', false, ['App.tsx']],
      ['/etc', true, ['hosts']],
      ['~/.claude', true, ['CLAUDE.md']],
    ]);
    expect(files.rows.map((r) => r.path)).toEqual([
      'README.md',
      'src',
      'src/server/store.test.ts',
      'src/server/store.ts',
      'web/src/App.tsx',
      '/etc/hosts',
      '~/.claude/CLAUDE.md',
    ]);
  });

  it('counts each file once per verb in the head line, and the calls behind a row', () => {
    const files = buildFiles(
      openWith([
        call('Read', { file_path: `${CWD}/a.ts` }),
        call('Edit', { file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' }),
        call('Read', { file_path: `${CWD}/a.ts`, offset: 1, limit: 10 }),
        call('Edit', { file_path: `${CWD}/a.ts`, old_string: 'c', new_string: 'd' }),
        call('Write', { file_path: `${CWD}/b.ts`, content: 'x' }),
        call('Read', { file_path: `${CWD}/c.ts` }),
        call('Grep', { pattern: 'x', path: `${CWD}/src` }),
        call('apply_patch', '*** Begin Patch\n*** Delete File: d.ts\n*** End Patch'),
      ]),
      MAIN,
    );
    expect(files.summary).toEqual({
      files: 5,
      edited: 1,
      created: 1,
      deleted: 1,
      read: 2,
      searched: 1,
    });
    const a = files.rows.find((r) => r.name === 'a.ts');
    expect(a?.counts).toEqual({ edited: 2, created: 0, deleted: 0, read: 2, searched: 0 });
    expect(a?.touches.map((t) => [t.tool.name, t.verb, t.lines])).toEqual([
      ['Read', 'read', null],
      ['Edit', 'edited', null],
      ['Read', 'read', '1-10'],
      ['Edit', 'edited', null],
    ]);
    expect(a?.lastAt).toBe(a?.touches.at(-1)?.tool.endedAt);
  });

  it('lists a failed or running call under its file without counting it as done', () => {
    const files = buildFiles(
      openWith([
        call(
          'Edit',
          { file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' },
          { status: 'error', resultPreview: 'String to replace not found' },
        ),
        call(
          'Edit',
          { file_path: `${CWD}/a.ts`, old_string: 'c', new_string: 'd' },
          { status: 'running', endedAt: null, durationMs: null },
        ),
        call('Edit', { file_path: `${CWD}/b.ts`, old_string: 'a', new_string: 'b' }),
      ]),
      MAIN,
    );
    const a = files.rows.find((r) => r.name === 'a.ts');
    expect(a).toMatchObject({ failed: 1, running: 1, counts: { edited: 0 } });
    expect(a?.touches).toHaveLength(2);
    // The head line counts files with an edit that landed.
    expect(files.summary.edited).toBe(1);
  });

  it('orders a row’s calls by their start, whatever order the store holds them in', () => {
    const later = call('Edit', { file_path: `${CWD}/a.ts`, old_string: 'c', new_string: 'd' });
    const earlier = call(
      'Read',
      { file_path: `${CWD}/a.ts` },
      { startedAt: at(0), endedAt: at(0) },
    );
    const files = buildFiles(openWith([later, earlier]), MAIN);
    expect(files.rows[0]?.touches.map((t) => t.tool.id)).toEqual([earlier.id, later.id]);
    expect(files.rows[0]?.lastAt).toBe(later.endedAt);
  });

  it('takes only the agents asked for', () => {
    const open = openWith([
      call('Read', { file_path: `${CWD}/main.ts` }),
      call('Read', { file_path: `${CWD}/sub.ts` }, { agentId: 'a1b2c3d4e5f60718' }),
    ]);
    expect(buildFiles(open, MAIN).rows.map((r) => r.name)).toEqual(['main.ts']);
    expect(buildFiles(open, subtreeIds(open, 'main')).rows.map((r) => r.name)).toEqual([
      'main.ts',
      'sub.ts',
    ]);
    expect(buildFiles(open, new Set(['a1b2c3d4e5f60718'])).rows.map((r) => r.name)).toEqual([
      'sub.ts',
    ]);
  });

  it('leaves out a search or listing of the working directory itself', () => {
    const files = buildFiles(
      openWith([
        call('Grep', { pattern: 'x', path: CWD }),
        call('Glob', { pattern: '**/*.ts', path: `${CWD}/` }),
        call('LS', { path: '.' }),
      ]),
      MAIN,
    );
    expect(files.rows).toEqual([]);
  });

  it('joins the same file named relative and absolute, as a patch and an edit name it', () => {
    const files = buildFiles(
      openWith([
        call(
          'apply_patch',
          '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch',
        ),
        call('Read', { file_path: `${CWD}/src/a.ts` }),
      ]),
      MAIN,
    );
    expect(files.rows).toHaveLength(1);
    expect(files.rows[0]?.counts).toMatchObject({ edited: 1, read: 1 });
  });

  it('keeps a session without a working directory on whole paths', () => {
    const files = buildFiles(
      openWith(
        [
          call('Read', { file_path: '/Users/demo/Dev/x/a.ts' }),
          call('Read', { file_path: 'b.ts' }),
        ],
        null,
      ),
      MAIN,
    );
    expect(files.rows.map((r) => [r.path, r.dir, r.outside])).toEqual([
      ['b.ts', '', true],
      ['~/Dev/x/a.ts', '~/Dev/x', true],
    ]);
  });

  it('reads the demo session: the fix read, edited and created files under its cwd', () => {
    const open = demoOpen();
    const files = buildFiles(open, subtreeIds(open, 'main'));
    expect(files.summary).toEqual({
      files: 6,
      edited: 3,
      created: 1,
      deleted: 0,
      read: 3,
      searched: 0,
    });
    expect(files.groups.map((g) => [g.dir, g.rows.map((r) => r.name)])).toEqual([
      ['', ['README.md']],
      ['notes', ['sorting.ipynb']],
      ['src/core', ['model.ts']],
      ['src/server', ['sessions.ts', 'store.test.ts', 'store.ts']],
    ]);
    const store = files.rows.find((r) => r.name === 'store.ts');
    expect(store).toMatchObject({
      counts: { edited: 2, read: 2 },
      failed: 1,
      outside: false,
    });
    expect(store?.touches.map((t) => t.tool.id)).toEqual([
      'tu_m2a',
      'tu_m2b',
      'tu_m2c',
      'tu_m2d',
      'tu_m2e',
    ]);
  });
});

describe('filterFiles', () => {
  const files = buildFiles(
    openWith([
      call('Edit', { file_path: `${CWD}/src/a.ts`, old_string: 'a', new_string: 'b' }),
      call('Write', { file_path: `${CWD}/src/new.ts`, content: '' }),
      call('Read', { file_path: `${CWD}/README.md` }),
      call('Grep', { pattern: 'x', path: `${CWD}/web` }),
      call(
        'Edit',
        { file_path: `${CWD}/src/missed.ts`, old_string: 'a', new_string: 'b' },
        { status: 'error' },
      ),
    ]),
    MAIN,
  );
  const names = (verbs: FileVerb[], query = '') =>
    filterFiles(files.rows, new Set(verbs), query).map((r) => r.name);

  it('keeps every row with no verb chosen, else the rows any chosen verb was tried on', () => {
    expect(names([])).toEqual(['README.md', 'web', 'a.ts', 'missed.ts', 'new.ts']);
    // A failed edit was still an edit, so the row shows under Edited.
    expect(names(['edited'])).toEqual(['a.ts', 'missed.ts']);
    expect(names(['created'])).toEqual(['new.ts']);
    expect(names(['read', 'searched'])).toEqual(['README.md', 'web']);
    expect(names(['edited', 'created'])).toEqual(['a.ts', 'missed.ts', 'new.ts']);
  });

  it('matches the text against the shown path, case apart', () => {
    expect(names([], 'SRC/')).toEqual(['a.ts', 'missed.ts', 'new.ts']);
    expect(names([], 'readme')).toEqual(['README.md']);
    expect(names(['edited'], 'miss')).toEqual(['missed.ts']);
    expect(names([], '  ')).toHaveLength(5);
    expect(names([], 'nothing-like-it')).toEqual([]);
  });
});

describe('lineDiff', () => {
  const kinds = (a: string, b: string) => lineDiff(a, b).map((l) => `${l.kind}:${l.text}`);

  it('keeps the lines around a change and marks what went and what came', () => {
    expect(kinds('a\nb\nc', 'a\nB\nc')).toEqual(['same:a', 'del:b', 'add:B', 'same:c']);
    expect(kinds('a', 'a\nb')).toEqual(['same:a', 'add:b']);
    expect(kinds('a\nb', 'b')).toEqual(['del:a', 'same:b']);
    expect(kinds('', 'x')).toEqual(['del:', 'add:x']);
    expect(kinds('x', 'x')).toEqual(['same:x']);
  });

  it('pairs the lines by their longest common run, so a moved block reads as one', () => {
    expect(kinds('a\nb\nc\nd', 'c\nd\na\nb')).toEqual([
      'del:a',
      'del:b',
      'same:c',
      'same:d',
      'add:a',
      'add:b',
    ]);
  });

  it('gives up pairing past a thousand lines a side, as one block out and one in', () => {
    const big = Array.from({ length: 1200 }, (_, i) => `line ${i}`).join('\n');
    const changed = big.replace('line 7\n', 'line seven\n').replace('line 1100\n', '');
    const lines = lineDiff(big, changed);
    // The shared head (7 lines) and tail (99 lines) still match; the middle is not paired.
    const kinds = lines.map((l) => l.kind);
    expect(kinds.slice(0, 7)).toEqual(Array(7).fill('same'));
    expect(kinds.slice(-99)).toEqual(Array(99).fill('same'));
    const middle = kinds.slice(7, -99);
    expect(middle).toEqual([...Array(1094).fill('del'), ...Array(1093).fill('add')]);
  });
});

describe('crossingKeys', () => {
  const open = demoOpen();
  const repo = demoRepo(open.session.cwd as string);

  it('names the other worktrees that changed each of the session’s files in the week', () => {
    expect([...crossingKeys(open, repo, demoWeek('7d'))]).toEqual([
      ['/Users/demo/Dev/glassbox/src/server/store.ts', ['glassbox-sidebar']],
      ['/Users/demo/Dev/glassbox/src/server/sessions.ts', ['glassbox-sidebar']],
    ]);
  });

  it('finds nothing without the week, nor when the other tree changed none of the session’s files', () => {
    expect(crossingKeys(open, repo, null).size).toBe(0);
    const week = demoWeek('7d');
    const quiet = {
      ...week,
      sessions: week.sessions.map((s) =>
        s.repo?.dir.includes('/worktrees/')
          ? { ...s, inWindow: { ...s.inWindow, files: undefined } }
          : s,
      ),
    };
    expect(crossingKeys(open, repo, quiet).size).toBe(0);
  });
});
