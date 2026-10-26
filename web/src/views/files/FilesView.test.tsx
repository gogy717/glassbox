import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../../src/core/model.js';
import type { OpenSession } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import { demoOpen } from '../../test/demo';
import { UiContext } from '../../ui';
import { FilesView } from './FilesView';
import { resetFilesPrefs } from './prefs';

function renderFiles(agentId = 'main', open: OpenSession = demoOpen(), locale: 'en' | 'zh' = 'en') {
  const navigate = vi.fn();
  const setFollow = vi.fn();
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <UiContext.Provider value={{ follow: true, setFollow }}>
        <FilesView open={open} agentId={agentId} navigate={navigate} />
      </UiContext.Provider>
    </I18nContext.Provider>,
  );
  return { navigate, setFollow };
}

/** The file rows: one button per file, which unfolds it. */
const rows = () => [...document.querySelectorAll<HTMLElement>('[aria-expanded]')];
const rowNames = () => rows().map((b) => b.querySelector('[title]')?.textContent);
const row = (name: RegExp) => screen.getByRole('button', { name });

/** The demo with one more tool call, on the given agent and request. */
function withTool(open: OpenSession, tool: Partial<ToolCall> & { name: string }): OpenSession {
  const base = open.toolCalls.get('tu_m2i');
  if (!base) throw new Error('fixture');
  const full: ToolCall = { ...base, id: `t_${tool.name}`, ...tool };
  return { ...open, toolCalls: new Map(open.toolCalls).set(full.id, full) };
}

/** The demo with no file tool at all: only Bash, Grep without a path, agents and web fetches. */
function withoutFiles(open: OpenSession): OpenSession {
  const kept = [...open.toolCalls].filter(
    ([, t]) => !/^(Read|Edit|MultiEdit|Write|NotebookEdit)$/.test(t.name),
  );
  return { ...open, toolCalls: new Map(kept) };
}

describe('FilesView', () => {
  beforeEach(() => {
    localStorage.clear();
    resetFilesPrefs();
  });

  it('heads the view with the files edited, created and read by the selected agent', () => {
    renderFiles();
    const head = screen.getByText(/files edited/).closest('p') as HTMLElement;
    expect(head).toHaveTextContent('3 files edited · 1 created · 3 read · Main');
    // Figures in mono, words in the UI face.
    expect([...head.querySelectorAll('.figure')].map((f) => f.textContent)).toEqual([
      '3',
      '1',
      '3',
    ]);
  });

  it('lists one row per file, grouped by directory under the project root', () => {
    renderFiles();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Project root',
      'notes',
      'src/core',
      'src/server',
    ]);
    expect(rowNames()).toEqual([
      'README.md',
      'sorting.ipynb',
      'model.ts',
      'sessions.ts',
      'store.test.ts',
      'store.ts',
    ]);
    const store = row(/^store\.ts/);
    expect(store).toHaveTextContent('edited ×2 · read ×2 · 1 failed');
    // The whole path on hover; the clock a figure.
    expect(
      within(store).getByTitle('/Users/demo/Dev/glassbox/src/server/store.ts'),
    ).toHaveTextContent('store.ts');
    expect(within(store).getByText(/^\d\d:\d\d:\d\d$/)).toHaveClass('figure');
    expect(rows()).toHaveLength(6);
  });

  it('unfolds a row into the calls behind it, each a link to its card in the execution chain', () => {
    const { navigate, setFollow } = renderFiles();
    fireEvent.click(row(/^store\.ts/));
    expect(row(/^store\.ts/)).toHaveAttribute('aria-expanded', 'true');
    const calls = within(screen.getByRole('list', { name: 'Tool calls' })).getAllByRole('button');
    expect(calls.map((c) => c.textContent)).toEqual([
      expect.stringMatching(/^Read·read·\d\d:\d\d:\d\d$/),
      expect.stringMatching(/^Edit·Failed·/),
      expect.stringMatching(/^Read:36-65·read·/),
      expect.stringMatching(/^Edit·edited·/),
      expect.stringMatching(/^Edit·edited·/),
    ]);
    fireEvent.click(calls[3] as HTMLElement);
    expect(setFollow).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenLastCalledWith({
      tab: 'flow',
      agentId: 'main',
      turnId: 'turn_m1',
      requestId: 'req_m2',
      card: 'tool:tu_m2d',
    });
    fireEvent.click(row(/^store\.ts/));
    expect(row(/^store\.ts/)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'Tool calls' })).toBeNull();
  });

  it('shows an Edit as what went and what came, line by line', () => {
    renderFiles();
    fireEvent.click(row(/^store\.ts/));
    // The failed edit and the two that landed: three diffs.
    const diffs = screen.getAllByLabelText('Change');
    expect(diffs).toHaveLength(3);
    const second = diffs[1] as HTMLElement;
    expect([...second.querySelectorAll('del')].map((d) => d.textContent)).toEqual([
      'return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));',
    ]);
    expect([...second.querySelectorAll('ins')].map((d) => d.textContent)).toEqual([
      'return sessions.sort(',
      '  (a, b) => busyFirst(a, b) || b.updatedAt.localeCompare(a.updatedAt),',
      ');',
    ]);
    // The third edit keeps the line it anchored on.
    const third = diffs[2] as HTMLElement;
    expect(third.querySelectorAll('del')).toHaveLength(0);
    expect(third.querySelectorAll('ins')).toHaveLength(3);
    expect(third.querySelector('[data-kind="same"]')).toHaveTextContent(
      'export function sortSessions(',
    );
  });

  it('shows each edit of a MultiEdit, a Write by its size and first lines, and a notebook cell', () => {
    const open = demoOpen();
    renderFiles('main', open);
    fireEvent.click(row(/^sessions\.ts/));
    expect(screen.getAllByLabelText('Change')).toHaveLength(2);
    fireEvent.click(row(/^store\.test\.ts/));
    const write = open.toolCalls.get('tu_m2f');
    if (!write) throw new Error('fixture');
    const content = (write.input as { content: string }).content;
    // Nine lines and a final newline, which is the file's end, not an empty line.
    expect(screen.getByText(/lines ·/).closest('p')).toHaveTextContent(
      `9 lines · ${content.length} characters`,
    );
    expect(screen.getByText(/describe\('sortSessions'/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull();
    fireEvent.click(row(/^sorting\.ipynb/));
    expect(screen.getByText('Cell cell-3 · replace · code')).toBeInTheDocument();
    expect(screen.getByText(/sessions\.sort\(key=lambda/)).toBeInTheDocument();
  });

  it('offers the rest of a long file written, and a patch as its own lines', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    let open = withTool(demoOpen(), {
      name: 'Write',
      input: { file_path: '/Users/demo/Dev/glassbox/docs/long.md', content: long },
      resultPreview: 'File created successfully',
    });
    open = withTool(open, {
      name: 'apply_patch',
      input: [
        '*** Begin Patch',
        '*** Update File: src/server/types.ts',
        '@@ export interface Session',
        '-  live: string;',
        '+  live: LiveState;',
        '*** End Patch',
      ].join('\n'),
    });
    renderFiles('main', open);
    fireEvent.click(row(/^long\.md/));
    expect(screen.getByText(/lines ·/).closest('p')).toHaveTextContent(
      `40 lines · ${long.length} characters`,
    );
    expect(screen.getByText(/line 12/)).toBeInTheDocument();
    expect(screen.queryByText(/line 13/)).toBeNull();
    expect(
      screen.getByRole('button', { name: `Show all (${long.length} characters)` }),
    ).toBeInTheDocument();
    fireEvent.click(row(/^types\.ts/));
    const patch = screen.getByLabelText('Change');
    expect(patch.querySelector('del')).toHaveTextContent('live: string;');
    expect(patch.querySelector('ins')).toHaveTextContent('live: LiveState;');
    expect(patch.querySelector('[data-kind="same"]')).toHaveTextContent(
      '@@ export interface Session',
    );
  });

  it('filters by what happened to a file, and by its path', () => {
    renderFiles();
    const chips = screen.getByRole('group', { name: 'Show files' });
    expect(
      within(chips)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Edited3', 'Created1', 'Read3']);
    fireEvent.click(within(chips).getByRole('button', { name: /^Created/ }));
    expect(rowNames()).toEqual(['store.test.ts']);
    fireEvent.click(within(chips).getByRole('button', { name: /^Read/ }));
    expect(rowNames()).toEqual(['README.md', 'model.ts', 'store.test.ts', 'store.ts']);
    fireEvent.click(within(chips).getByRole('button', { name: /^Created/ }));
    fireEvent.click(within(chips).getByRole('button', { name: /^Read/ }));
    expect(rowNames()).toHaveLength(6);

    const filter = screen.getByRole('searchbox', { name: 'Filter by path' });
    fireEvent.change(filter, { target: { value: 'SRC/SERVER' } });
    expect(rowNames()).toEqual(['sessions.ts', 'store.test.ts', 'store.ts']);
    fireEvent.change(filter, { target: { value: 'nothing-like-it' } });
    expect(screen.getByText('No file matches')).toBeInTheDocument();
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(rowNames()).toHaveLength(6);
  });

  it('includes the sub-agents’ files until the toggle leaves them out, and remembers that', () => {
    const open = withTool(demoOpen(), {
      name: 'Read',
      agentId: 'a1b2c3d4e5f60718',
      requestId: 'req_s1',
      input: { file_path: '/Users/demo/Dev/glassbox/src/adapters/claude-code/records.ts' },
    });
    renderFiles('main', open);
    const toggle = () => screen.getByRole('button', { name: 'Include sub-agents' });
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(rowNames()).toContain('records.ts');
    expect(screen.getByText(/files edited/).closest('p')).toHaveTextContent('· 4 read');
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(rowNames()).not.toContain('records.ts');
    expect(screen.getByText(/files edited/).closest('p')).toHaveTextContent('· 3 read');
    expect(JSON.parse(localStorage.getItem('glassbox.files') ?? '{}')).toEqual({
      subAgents: false,
    });
  });

  it('scopes the list to a sub-agent when one is selected', () => {
    const open = withTool(demoOpen(), {
      name: 'Read',
      agentId: 'a1b2c3d4e5f60718',
      requestId: 'req_s1',
      input: { file_path: '/Users/demo/Dev/glassbox/src/adapters/claude-code/records.ts' },
    });
    renderFiles('a1b2c3d4e5f60718', open);
    expect(rowNames()).toEqual(['records.ts']);
    expect(screen.getByText(/files edited/).closest('p')).toHaveTextContent(
      '0 files edited · 0 created · 1 read · Explore transcript format',
    );
    // A leaf agent has no sub-agents to include.
    expect(screen.queryByRole('button', { name: 'Include sub-agents' })).toBeNull();
  });

  it('says so when the agent, or the whole session, touched no file', () => {
    renderFiles('af00000000000001');
    expect(screen.getByText('No files were read or changed by this agent')).toBeInTheDocument();
  });

  it('says so for the whole session, keeping the toggle at hand', () => {
    renderFiles('main', withoutFiles(demoOpen()));
    expect(screen.getByText('No files were read or changed in this session')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Include sub-agents' }));
    expect(screen.getByText('No files were read or changed by this agent')).toBeInTheDocument();
  });

  it('gives the rows one tab stop, the arrow keys moving between files', () => {
    renderFiles();
    const [first, second] = rows();
    expect(first).toHaveAttribute('tabindex', '0');
    expect(second).toHaveAttribute('tabindex', '-1');
    (first as HTMLElement).focus();
    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowDown' });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second as HTMLElement, { key: 'End' });
    expect(rows().at(-1)).toHaveFocus();
  });

  it('speaks Chinese', () => {
    renderFiles('main', demoOpen(), 'zh');
    expect(screen.getByText(/修改了/).closest('p')).toHaveTextContent(
      '修改了 3 个文件 · 新建 1 个 · 读取 3 个 · 主会话',
    );
    expect(screen.getByRole('heading', { level: 3, name: '项目根目录' })).toBeInTheDocument();
    expect(row(/^store\.ts/)).toHaveTextContent('修改 ×2 · 读取 ×2 · 1 次失败');
  });
});
