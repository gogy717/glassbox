import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDemoSessions } from '../../../src/core/fixtures/demo.js';
import type { SessionSummary } from '../../../src/core/model.js';
import { I18nContext, makeI18n } from '../i18n';
import { DEFAULT_PREFS, type Prefs } from '../prefs';
import { DEMO_NOW } from '../test/demo';
import tagCss from './AgentTag.module.css';
import { WAIT_MS } from './Delayed';
import rowCss from './SessionRow.module.css';
import { SessionSidebar } from './SessionSidebar';

const sessions = createDemoSessions(DEMO_NOW);
// A session's row, not the pin beside it in the same list item.
const isRow = (b: HTMLElement) => b.classList.contains(rowCss.row as string);

function renderSidebar(onSelect = vi.fn()) {
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <SessionSidebar
        sessions={sessions}
        selectedId={sessions[0]?.id ?? null}
        now={DEMO_NOW.getTime()}
        onSelect={onSelect}
      />
    </I18nContext.Provider>,
  );
  return onSelect;
}

describe('SessionSidebar', () => {
  // I3 / I3b F1: "No sessions found" is a claim about the list, so it waits for the list to
  // arrive; until then a quiet "Connecting…" says why the list is empty.
  it('says it is connecting until the first list has loaded, then that there are none', () => {
    const empty = (loaded: boolean) => (
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={[]}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          loaded={loaded}
          onSelect={() => {}}
        />
      </I18nContext.Provider>
    );
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { rerender } = render(empty(false));
    expect(screen.queryByText('No sessions found')).toBeNull();
    // F-web W8: not for the first 200 ms, so a quick local list never flashes it.
    expect(screen.queryByText('Connecting…')).toBeNull();
    act(() => vi.advanceTimersByTime(WAIT_MS));
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    rerender(empty(true));
    expect(screen.getByText('No sessions found')).toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).toBeNull();
  });

  it('marks every session with its agent, in that agent’s colours, even with one agent', () => {
    renderSidebar();
    const items = screen.getAllByRole('button').filter(isRow);
    const tags = items.map((b) => b.querySelector('[data-agent]'));
    expect(tags.every((tag) => tag?.getAttribute('data-agent') === 'claude-code')).toBe(true);
    const tag = tags[0] as HTMLElement;
    expect(tag).toHaveClass(tagCss.tag as string);
    expect(tag).toHaveTextContent('Claude Code');
    expect(tag.style.getPropertyValue('--tag-fg')).toBe('var(--agent-claude-code-fg)');
    expect(tag.style.getPropertyValue('--tag-bg')).toBe('var(--agent-claude-code-bg)');
    // One agent: nothing to filter by.
    expect(screen.queryByRole('group', { name: 'Filter by agent' })).toBeNull();
  });

  it('gives each known agent its own colours and an unknown one the neutral colours', () => {
    const kinds = ['claude-code', 'codex', 'grok', 'oh-my-pi', 'opencode', 'aider'];
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={kinds.map((agent, i) => ({
            ...(sessions[0] as SessionSummary),
            id: `s${i}`,
            agent,
          }))}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    const list = screen.getByRole('list', { name: 'glassbox' });
    const tags = [...list.querySelectorAll<HTMLElement>('[data-agent]')];
    expect(tags.map((t) => [t.textContent, t.dataset.tone])).toEqual([
      ['Claude Code', 'claude-code'],
      ['Codex', 'codex'],
      ['Grok', 'grok'],
      ['oh-my-pi', 'oh-my-pi'],
      ['OpenCode', 'opencode'],
      ['aider', 'other'],
    ]);
    expect(tags[5]?.style.getPropertyValue('--tag-fg')).toBe('var(--agent-other-fg)');
  });

  it('filters the list to one agent from its chip, and back', () => {
    const mixed = sessions.map((s, i) => (i === 1 ? { ...s, agent: 'grok' } : s));
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={mixed}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    const group = screen.getByRole('group', { name: 'Filter by agent' });
    const chips = within(group).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['All 3', 'Claude Code 2', 'Grok 1']);
    const rows = () => screen.getAllByRole('button').filter(isRow);
    expect(rows()).toHaveLength(sessions.length);

    const grok = within(group).getByRole('button', { name: /^Grok/ });
    expect(grok).toHaveAttribute('aria-pressed', 'false');
    expect(grok).toHaveAttribute('title', 'Show only Grok sessions');
    fireEvent.click(grok);
    expect(grok).toHaveAttribute('aria-pressed', 'true');
    expect(grok).toHaveAttribute('title', 'Show sessions of every agent');
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0] as HTMLElement).getByText('Grok')).toBeInTheDocument();

    fireEvent.click(grok);
    expect(grok).toHaveAttribute('aria-pressed', 'false');
    expect(rows()).toHaveLength(sessions.length);
  });

  it('keeps the chips in one order, whichever agent was active last', () => {
    // Newest first in the list: an unknown agent, then Grok, then Claude Code.
    const mixed = sessions.map((s, i) =>
      i === 0 ? { ...s, agent: 'aider' } : i === 1 ? { ...s, agent: 'grok' } : s,
    );
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={mixed}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    const group = screen.getByRole('group', { name: 'Filter by agent' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((c) => c.textContent),
    ).toEqual(['All 3', 'Claude Code 1', 'Grok 1', 'aider 1']);
  });

  it('offers chips only for agents with listed sessions, probes included only when shown', () => {
    const probe = { ...(sessions[1] as SessionSummary), agent: 'grok', tags: ['probe'] };
    const list = [sessions[0] as SessionSummary, probe];
    const sidebar = (showProbes: boolean) => (
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={list}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          showProbes={showProbes}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>
    );
    const { rerender } = render(sidebar(false));
    expect(screen.queryByRole('group', { name: 'Filter by agent' })).toBeNull();
    rerender(sidebar(true));
    const group = screen.getByRole('group', { name: 'Filter by agent' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((c) => c.textContent),
    ).toEqual(['All 2', 'Claude Code 1', 'Grok 1']);
  });

  it('keeps the open session’s row while another agent is picked', () => {
    const mixed = sessions.map((s, i) => (i === 1 ? { ...s, agent: 'grok' } : s));
    const open = mixed[0] as SessionSummary;
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={mixed}
          selectedId={open.id}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    const group = screen.getByRole('group', { name: 'Filter by agent' });
    fireEvent.click(within(group).getByRole('button', { name: /^Grok/ }));
    const rows = screen.getAllByRole('button').filter(isRow);
    expect(rows).toHaveLength(2);
    expect(rows.find((b) => b.getAttribute('aria-current') === 'true')).toHaveTextContent(
      open.title ?? '',
    );
  });

  it('keeps one tab stop across the rows the filter leaves, with the chips outside it', () => {
    const mixed = sessions.map((s, i) => (i === 0 ? s : { ...s, agent: 'grok' }));
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={mixed}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    const group = screen.getByRole('group', { name: 'Filter by agent' });
    for (const chip of within(group).getAllByRole('button'))
      expect(chip).not.toHaveAttribute('data-roving');
    fireEvent.click(within(group).getByRole('button', { name: /^Grok/ }));
    const rows = screen.getAllByRole('button').filter(isRow);
    expect(rows).toHaveLength(sessions.length - 1);
    // One stop, on the first row the filter left.
    expect(rows.map((r) => r.tabIndex)).toEqual(rows.map((_, i) => (i === 0 ? 0 : -1)));
    (rows[0] as HTMLElement).focus();
    // The next row is in another group: its title comes between (D, F7).
    fireEvent.keyDown(rows[0] as HTMLElement, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: 'blog' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1] as HTMLElement, { key: 'End' });
    expect(rows.at(-1)).toHaveFocus();
    // Back to every agent: the stop stays on the row last focused.
    fireEvent.click(within(group).getByRole('button', { name: /^Grok/ }));
    const all = screen.getAllByRole('button').filter(isRow);
    expect(all.filter((r) => r.tabIndex === 0)).toEqual([rows.at(-1)]);
  });

  it('shows everything again when the filtered agent’s sessions are gone', () => {
    const mixed = sessions.map((s, i) => (i === 1 ? { ...s, agent: 'grok' } : s));
    const sidebar = (list: SessionSummary[]) => (
      <I18nContext.Provider value={makeI18n('zh')}>
        <SessionSidebar
          sessions={list}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>
    );
    const { rerender } = render(sidebar(mixed));
    const group = screen.getByRole('group', { name: '按 agent 筛选' });
    fireEvent.click(within(group).getByRole('button', { name: /^Grok/ }));
    expect(screen.getAllByRole('button').filter(isRow)).toHaveLength(1);
    rerender(sidebar(sessions));
    expect(screen.getAllByRole('button').filter(isRow)).toHaveLength(sessions.length);
  });

  it('cuts long text inside the row and puts all of it in the row’s tooltip', () => {
    const long = { ...(sessions[0] as SessionSummary), title: 'A very long title '.repeat(8) };
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={[long]}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    const row = screen.getByRole('button', { name: /A very long title/ });
    expect(row).toHaveClass(rowCss.row as string);
    // Nothing cut short (jsdom lays nothing out): the tooltip only adds the folder, so a screen
    // reader does not hear the row's text twice.
    fireEvent.pointerEnter(row);
    expect(row).toHaveAttribute('title', long.cwd);
    // Cut short: the tooltip has all of it.
    const title = row.querySelector<HTMLElement>(`.${rowCss.title}`) as HTMLElement;
    Object.defineProperty(title, 'scrollWidth', { configurable: true, value: 400 });
    Object.defineProperty(title, 'clientWidth', { configurable: true, value: 200 });
    fireEvent.pointerEnter(row);
    const tip = (row.getAttribute('title') ?? '').split('\n');
    expect(tip[0]).toBe(long.title);
    expect(tip[1]).toMatch(/^Claude Code · Running · .+ · 42K output tokens$/);
    expect(tip[2]).toBe(long.cwd);
    // Time and tokens sit in the part that gives way first.
    expect(row.querySelector(`.${rowCss.when}`)).toHaveTextContent(/42K out/);
  });

  it('groups sessions by project with running ones first', () => {
    renderSidebar();
    const groups = screen.getAllByRole('list');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'glassbox',
      'shopfront',
      'blog',
    ]);
  });

  it('shows title (or an untitled label), live state, relative time and known token totals', () => {
    renderSidebar();
    const busy = screen.getByRole('button', { name: /Live viewer research/ });
    expect(within(busy).getByText('Running')).toBeInTheDocument();
    expect(within(busy).getByText('now')).toBeInTheDocument();
    expect(within(busy).getByText('42K output tokens')).toBeInTheDocument();
    const untitled = screen.getByRole('button', { name: /Untitled session/ });
    expect(within(untitled).getByText('Closed')).toBeInTheDocument();
    expect(within(untitled).queryByText(/tokens|out/)).toBeNull();
  });

  it('labels a session that is waiting for the user', () => {
    render(
      <I18nContext.Provider value={makeI18n('zh')}>
        <SessionSidebar
          sessions={[{ ...(sessions[1] as (typeof sessions)[number]), live: 'waiting' }]}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={() => {}}
        />
      </I18nContext.Provider>,
    );
    // In the words of Home's board: no tool is blocked, so it is the person's turn.
    expect(screen.getByText('轮到你了')).toBeInTheDocument();
    expect(screen.queryByText('等你确认')).toBeNull();
  });

  it('marks the selected session', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: /Live viewer research/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('button', { name: /Fix flaky login/ })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('is one tab stop, at the selected session, with arrow keys across projects', () => {
    renderSidebar();
    const items = screen.getAllByRole('button').filter(isRow);
    expect(items.filter((b) => b.tabIndex === 0)).toEqual([
      screen.getByRole('button', { name: /Live viewer research/ }),
    ]);
    const first = items[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    // The next session sits in another project's group: its title comes first (D, F7).
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'shopfront' }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    expect(items[1]?.closest('ul')).not.toBe(first.closest('ul'));
    fireEvent.keyDown(items[1] as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(items.at(-1));
  });

  it('filters by the search box and says when nothing matches', () => {
    renderSidebar();
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'shopfront' } });
    expect(screen.getAllByRole('list')).toHaveLength(1);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No matching sessions')).toBeInTheDocument();
  });

  it('reports the clicked session', () => {
    const onSelect = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: /Fix flaky login/ }));
    expect(onSelect).toHaveBeenCalledWith(sessions[1]?.id);
  });

  it('filters by state from chips, counting waiting as running, and offers the rest back', () => {
    // The demo lists one running, one idle and one closed session; make the closed one waiting.
    const states = sessions.map((x, i) => (i === 2 ? { ...x, live: 'waiting' as const } : x));
    const extra = {
      ...(sessions[1] as SessionSummary),
      id: 'claude-code:extra',
      live: 'closed' as const,
    };
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={[...states, extra]}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    const group = screen.getByRole('group', { name: 'Filter by state' });
    const chips = within(group).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['All', 'Running 2', 'Idle 1', 'Closed 1']);
    expect(chips[0]).toHaveAttribute('aria-pressed', 'true');
    const rows = () => screen.getAllByRole('button').filter(isRow);

    fireEvent.click(within(group).getByRole('button', { name: /^Running/ }));
    expect(
      rows()
        .map((r) => r.querySelector('[data-state]')?.getAttribute('data-state'))
        .sort(),
    ).toEqual(['busy', 'waiting']);
    expect(screen.getByText(/^2 more sessions are idle or closed\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(rows()).toHaveLength(4);
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByText(/more sessions? (is|are)/)).toBeNull();
  });

  it('draws no chip for a state no session is in, and no state row for a single state', () => {
    const noIdle = sessions.filter((x) => x.live !== 'idle');
    const { rerender } = render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={noIdle}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    const group = screen.getByRole('group', { name: 'Filter by state' });
    expect(within(group).queryByRole('button', { name: /^Idle/ })).toBeNull();
    const closed = sessions.map((x) => ({ ...x, live: 'closed' as const }));
    rerender(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={closed}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    expect(screen.queryByRole('group', { name: 'Filter by state' })).toBeNull();
  });

  it('keeps the open session’s row under a state filter, marked as the one open', () => {
    const open = sessions.find((x) => x.live === 'closed') as SessionSummary;
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={sessions}
          selectedId={open.id}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    const group = screen.getByRole('group', { name: 'Filter by state' });
    fireEvent.click(within(group).getByRole('button', { name: /^Running/ }));
    const current = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0]?.querySelector('[data-state]')).toHaveAttribute('data-state', 'closed');
  });

  it('shows every agent again from the All chip', () => {
    const mixed = sessions.map((x, i) => (i === 1 ? { ...x, agent: 'grok' } : x));
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={mixed}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    const group = screen.getByRole('group', { name: 'Filter by agent' });
    fireEvent.click(within(group).getByRole('button', { name: /^Grok/ }));
    expect(within(group).getByRole('button', { name: /^All/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    fireEvent.click(within(group).getByRole('button', { name: /^All/ }));
    expect(within(group).getByRole('button', { name: /^All/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getAllByRole('button').filter(isRow)).toHaveLength(sessions.length);
  });

  it('clears a state filter whose sessions are gone, so the next one does not filter again', () => {
    const sidebar = (list: SessionSummary[]) => (
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={list}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>
    );
    const { rerender } = render(sidebar(sessions));
    const group = () => screen.getByRole('group', { name: 'Filter by state' });
    const running = within(group()).getByRole('button', { name: /^Running/ });
    expect(running).toHaveAttribute('title', 'Running, including sessions waiting for you');
    fireEvent.click(running);
    running.focus();
    // The running session stops: no running chip to keep pressed.
    const stopped = sessions.map((x) => (x.live === 'busy' ? { ...x, live: 'idle' as const } : x));
    rerender(sidebar(stopped));
    const all = within(group()).getByRole('button', { name: 'All' });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(document.activeElement).toBe(all);
    // A session starts running again: the list stays whole.
    rerender(sidebar(sessions));
    expect(screen.getAllByRole('button').filter(isRow)).toHaveLength(sessions.length);
    expect(within(group()).getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('clears an agent filter whose sessions are gone, so its next session does not filter again', () => {
    const three = sessions.map((x, i) =>
      i === 1 ? { ...x, agent: 'grok' } : i === 2 ? { ...x, agent: 'codex' } : x,
    );
    const sidebar = (list: SessionSummary[]) => (
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={list}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>
    );
    const { rerender } = render(sidebar(three));
    const group = () => screen.getByRole('group', { name: 'Filter by agent' });
    const grok = within(group()).getByRole('button', { name: /^Grok/ });
    fireEvent.click(grok);
    grok.focus();
    rerender(sidebar(three.filter((x) => x.agent !== 'grok')));
    const all = within(group()).getByRole('button', { name: /^All/ });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(document.activeElement).toBe(all);
    rerender(sidebar(three));
    expect(screen.getAllByRole('button').filter(isRow)).toHaveLength(three.length);
  });

  it('keeps a chip row while its filter is armed, even with one choice left, so All can clear it', () => {
    const two = sessions.map((x, i) => (i === 1 ? { ...x, agent: 'grok' } : x));
    const sidebar = (list: SessionSummary[]) => (
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={list}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>
    );
    const { rerender } = render(sidebar(two));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Filter by agent' })).getByRole('button', {
        name: /^Grok/,
      }),
    );
    // Every Claude Code session goes: Grok is the only agent left, and still the filter.
    rerender(sidebar(two.filter((x) => x.agent === 'grok')));
    const group = screen.getByRole('group', { name: 'Filter by agent' });
    expect(within(group).getByRole('button', { name: /^Grok/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(group).getByRole('button', { name: /^All/ }));
    // Nothing armed and one choice: no row.
    expect(screen.queryByRole('group', { name: 'Filter by agent' })).toBeNull();
  });
});

/** The sidebar with its prefs held in state, as the app holds them. */
function Harness({
  sessions: list,
  selectedId = null,
  locale = 'en',
  prefs: initial = DEFAULT_PREFS,
  onPrefs,
}: {
  sessions: SessionSummary[];
  selectedId?: string | null;
  locale?: 'en' | 'zh';
  prefs?: Prefs;
  onPrefs?(p: Prefs): void;
}) {
  const [prefs, setPrefs] = useState(initial);
  return (
    <I18nContext.Provider value={makeI18n(locale)}>
      <SessionSidebar
        sessions={list}
        selectedId={selectedId}
        now={DEMO_NOW.getTime()}
        prefs={prefs}
        onPrefs={(p) => {
          setPrefs(p);
          onPrefs?.(p);
        }}
        onSelect={vi.fn()}
      />
    </I18nContext.Provider>
  );
}

const lists = () => screen.getAllByRole('list').map((l) => l.getAttribute('aria-label'));
const titles = (list: HTMLElement) =>
  within(list)
    .getAllByRole('button')
    .filter(isRow)
    .map((r) => r.querySelector(`.${rowCss.title}`)?.textContent);
const pinOf = (row: HTMLElement) =>
  within(row.parentElement as HTMLElement).getByRole('button', { name: 'Pin' });

// Branch D (F7) item 2: pins, a first group of their own, kept in the prefs by id.
describe('SessionSidebar worktrees', () => {
  const repo = (root: string, dir = root) => ({
    root,
    dir,
    name: root.split('/').at(-1) as string,
  });
  const trees: SessionSummary[] = [
    {
      ...(sessions[0] as SessionSummary),
      id: 'main',
      title: 'In the repository',
      cwd: '/home/dev/src/glassbox',
      repo: repo('/home/dev/src/glassbox'),
    },
    {
      ...(sessions[1] as SessionSummary),
      id: 'tree',
      title: 'In a worktree',
      cwd: '/home/dev/work/glassbox/weever',
      repo: repo('/home/dev/src/glassbox', '/home/dev/work/glassbox/weever'),
    },
    { ...(sessions[2] as SessionSummary), id: 'other', title: 'Elsewhere', repo: null },
  ];
  const renderTrees = (locale: 'en' | 'zh' = 'en') =>
    render(
      <I18nContext.Provider value={makeI18n(locale)}>
        <SessionSidebar
          sessions={trees}
          selectedId="main"
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>,
    );

  it('lists one group for the repository, its working trees as named sub-lists, main first', () => {
    renderTrees();
    const group = screen.getByRole('list', { name: 'glassbox' });
    const lists = within(group).getAllByRole('list');
    expect(lists.map((l) => l.getAttribute('aria-label'))).toEqual([
      'glassbox · glassbox · main working tree',
      'glassbox · weever',
    ]);
    expect(within(lists[0] as HTMLElement).getByText('In the repository')).toBeInTheDocument();
    expect(within(lists[1] as HTMLElement).getByText('In a worktree')).toBeInTheDocument();
    // The tree's name carries its directory, and the group's title the repository's root.
    expect(
      screen.getAllByTitle('/home/dev/work/glassbox/weever').map((el) => el.textContent),
    ).toContain('weever');
    expect(screen.getByRole('button', { name: /^glassbox/ })).toHaveAttribute(
      'title',
      '/home/dev/src/glassbox',
    );
    // A session of no repository keeps a plain group of its own.
    expect(screen.getByRole('list', { name: 'blog' })).toBeInTheDocument();
  });

  it('names the main working tree in Chinese too', () => {
    renderTrees('zh');
    expect(
      screen.getByRole('list', { name: 'glassbox · glassbox · 主工作树' }),
    ).toBeInTheDocument();
  });
});

describe('SessionSidebar pins', () => {
  it('pins a session from the button beside its row into a first Pinned group, in the order pinned', () => {
    const onPrefs = vi.fn();
    render(<Harness sessions={sessions} onPrefs={onPrefs} />);
    const pin = pinOf(screen.getByRole('button', { name: /Fix flaky login/ }));
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    expect(pin).toHaveAttribute('title', 'Pin · P');
    // Not a tab stop of its own: the rows are one, and P on a row pins it.
    expect(pin.tabIndex).toBe(-1);
    fireEvent.click(pin);
    expect(onPrefs).toHaveBeenLastCalledWith(
      expect.objectContaining({ pinned: [sessions[1]?.id] }),
    );
    expect(lists()).toEqual(['Pinned', 'glassbox', 'blog']);
    fireEvent.click(pinOf(screen.getByRole('button', { name: /Untitled session/ })));
    expect(lists()).toEqual(['Pinned', 'glassbox']);
    const pinned = screen.getByRole('list', { name: 'Pinned' });
    expect(titles(pinned)).toEqual(['Fix flaky login test', 'Untitled session']);
    const pressed = within(pinned).getAllByRole('button', { name: 'Pin', pressed: true });
    expect(pressed).toHaveLength(2);
    expect(pressed[0]).toHaveAttribute('title', 'Unpin · P');
    // Unpinned, a session goes back to its project.
    fireEvent.click(pressed[0] as HTMLElement);
    expect(lists()).toEqual(['Pinned', 'glassbox', 'shopfront']);
    expect(onPrefs).toHaveBeenLastCalledWith(
      expect.objectContaining({ pinned: [sessions[2]?.id] }),
    );
  });

  it('pins and unpins the focused row with P, and keeps focus on it where it lands', () => {
    render(<Harness sessions={sessions} />);
    const row = screen.getByRole('button', { name: /Fix flaky login/ });
    row.focus();
    fireEvent.keyDown(row, { key: 'p' });
    const moved = within(screen.getByRole('list', { name: 'Pinned' })).getByRole('button', {
      name: /Fix flaky login/,
    });
    expect(moved).toHaveFocus();
    expect(moved.tabIndex).toBe(0);
    // With a modifier it is some other key (⌘P prints).
    fireEvent.keyDown(moved, { key: 'p', metaKey: true });
    expect(screen.getByRole('list', { name: 'Pinned' })).toBeInTheDocument();
    fireEvent.keyDown(moved, { key: 'P' });
    expect(screen.queryByRole('list', { name: 'Pinned' })).toBeNull();
    expect(screen.getByRole('button', { name: /Fix flaky login/ })).toHaveFocus();
  });

  it('lists the saved pins first, and names the group in Chinese too', () => {
    render(
      <Harness
        sessions={sessions}
        locale="zh"
        prefs={{ ...DEFAULT_PREFS, pinned: [sessions[2]?.id as string, sessions[0]?.id as string] }}
      />,
    );
    expect(lists()).toEqual(['已置顶', 'shopfront']);
    expect(titles(screen.getByRole('list', { name: '已置顶' }))).toEqual([
      '未命名会话',
      'Live viewer research (demo)',
    ]);
    expect(screen.getAllByRole('button', { name: '置顶', pressed: true })).toHaveLength(2);
  });
});

// Branch D (F7) item 1: a group folds from its title; the folded set is kept in the prefs.
describe('SessionSidebar folding', () => {
  it('folds a group from its title, which keeps its count and the dots of its running sessions', () => {
    const onPrefs = vi.fn();
    render(<Harness sessions={sessions} onPrefs={onPrefs} />);
    const title = screen.getByRole('button', { name: 'glassbox' });
    expect(title).toHaveAttribute('aria-expanded', 'true');
    // The directory its sessions ran in, as the tooltip.
    expect(title).toHaveAttribute('title', '/Users/demo/Dev/glassbox');
    expect(title).toHaveAttribute(
      'aria-controls',
      screen.getByRole('list', { name: 'glassbox' }).id,
    );
    fireEvent.click(title);
    expect(onPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ folded: ['glassbox'] }));
    expect(lists()).toEqual(['shopfront', 'blog']);
    const folded = screen.getByRole('button', { name: /^glassbox/ });
    expect(folded).toHaveAttribute('aria-expanded', 'false');
    expect(folded).not.toHaveAttribute('aria-controls');
    expect(folded).toHaveAccessibleName('glassbox 1 session 1 running');
    expect(folded.querySelector('.figure')).toHaveTextContent('1');
    expect(folded.querySelector('[data-state="busy"]')).not.toBeNull();
    fireEvent.click(folded);
    expect(onPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ folded: [] }));
    expect(lists()).toEqual(['glassbox', 'shopfront', 'blog']);
  });

  it('keeps the open session’s row on show in a folded group, and says who waits in it', () => {
    // A waiting session beside the open one in shopfront, as saved folded.
    const two = sessions.map((s, i) =>
      i === 2
        ? { ...s, live: 'waiting' as const, project: 'shopfront', cwd: sessions[1]?.cwd ?? null }
        : s,
    );
    render(
      <Harness
        sessions={two}
        selectedId={sessions[1]?.id ?? null}
        prefs={{ ...DEFAULT_PREFS, folded: ['shopfront'] }}
      />,
    );
    const title = screen.getByRole('button', { name: /^shopfront/ });
    expect(title).toHaveAttribute('aria-expanded', 'false');
    expect(title).toHaveAccessibleName('shopfront 2 sessions 1 waiting for you');
    expect(title.querySelector('[data-state="waiting"]')).not.toBeNull();
    expect(titles(screen.getByRole('list', { name: 'shopfront' }))).toEqual([
      'Fix flaky login test',
    ]);
  });

  it('folds from the keyboard: the titles sit among the rows under the list’s one tab stop', () => {
    render(<Harness sessions={sessions} />);
    const first = screen.getByRole('button', { name: /Live viewer research/ });
    // Tab enters the list at a row, not at a title, until something was focused.
    expect(screen.getByRole('button', { name: 'shopfront' }).tabIndex).toBe(-1);
    expect(first.tabIndex).toBe(0);
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const title = screen.getByRole('button', { name: 'shopfront' });
    expect(title).toHaveFocus();
    expect(title.tabIndex).toBe(0);
    // A native button: Enter and Space press it (jsdom does not), as a click does.
    fireEvent.click(title);
    expect(title).toHaveAttribute('aria-expanded', 'false');
    expect(title).toHaveFocus();
    fireEvent.keyDown(title, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: 'blog' })).toHaveFocus();
  });

  it('speaks a folded group in Chinese', () => {
    render(
      <Harness
        sessions={sessions}
        locale="zh"
        prefs={{ ...DEFAULT_PREFS, folded: ['glassbox'] }}
      />,
    );
    expect(screen.getByRole('button', { name: /^glassbox/ })).toHaveAccessibleName(
      'glassbox 1 个会话 1 个运行中',
    );
  });
});

// Branch D (F7) item 4: a group lists its running and idle sessions and the 5 most recently
// closed; "N more" unfolds the rest, for this page only.
describe('SessionSidebar "N more"', () => {
  const idle = sessions[1] as SessionSummary;
  const minutesAgo = (n: number) => new Date(DEMO_NOW.getTime() - n * 60_000).toISOString();
  // shopfront: the idle session, then eight closed ones, newest first.
  const many = [
    sessions[0] as SessionSummary,
    idle,
    ...Array.from({ length: 8 }, (_, i) => ({
      ...idle,
      id: `claude-code:closed-${i}`,
      title: `Closed ${i}`,
      live: 'closed' as const,
      updatedAt: minutesAgo(100 + i),
    })),
  ];
  const shopfront = () => titles(screen.getByRole('list', { name: 'shopfront' }));

  it('lists the 5 most recent closed sessions, then "N more", which unfolds the rest', () => {
    render(<Harness sessions={many} />);
    expect(shopfront()).toEqual([
      'Fix flaky login test',
      'Closed 0',
      'Closed 1',
      'Closed 2',
      'Closed 3',
      'Closed 4',
    ]);
    const more = screen.getByRole('button', { name: '3 more' });
    // Under the list's one tab stop, after the group's rows.
    expect(more).toHaveAttribute('data-roving');
    const last = screen.getByRole('button', { name: /Closed 4/ });
    last.focus();
    fireEvent.keyDown(last, { key: 'ArrowDown' });
    expect(more).toHaveFocus();
    fireEvent.click(more);
    expect(shopfront()).toHaveLength(9);
    expect(screen.queryByRole('button', { name: /more$/ })).toBeNull();
    // Focus moves on to the first row revealed.
    expect(screen.getByRole('button', { name: /Closed 5/ })).toHaveFocus();
  });

  it('shows every closed session under a search or the Closed filter', () => {
    render(<Harness sessions={many} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'closed' } });
    expect(screen.queryByRole('button', { name: /more$/ })).toBeNull();
    expect(shopfront()).toHaveLength(8);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: '3 more' })).toBeInTheDocument();
    const states = screen.getByRole('group', { name: 'Filter by state' });
    fireEvent.click(within(states).getByRole('button', { name: /^Closed/ }));
    expect(screen.queryByRole('button', { name: /more$/ })).toBeNull();
    expect(shopfront()).toHaveLength(8);
  });

  it('keeps the open session on show past the 5, and says N more in Chinese', () => {
    render(<Harness sessions={many} locale="zh" selectedId="claude-code:closed-7" />);
    expect(shopfront()).toEqual([
      'Fix flaky login test',
      'Closed 0',
      'Closed 1',
      'Closed 2',
      'Closed 3',
      'Closed 4',
      'Closed 7',
    ]);
    expect(screen.getByRole('button', { name: '还有 2 个' })).toBeInTheDocument();
  });
});

// Branch D (F7) item 3: Group by Project · Time, in the head; the choice is kept in the prefs.
describe('SessionSidebar grouping', () => {
  it('groups by time from the switch, today to earlier, and remembers the choice', () => {
    const onPrefs = vi.fn();
    render(<Harness sessions={sessions} onPrefs={onPrefs} />);
    const by = screen.getByRole('radiogroup', { name: 'Group by' });
    expect(within(by).getByRole('radio', { name: 'Project' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(within(by).getByRole('radio', { name: 'Time' }));
    expect(onPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'time' }));
    // The demo: two sessions today, one earlier this week; nothing yesterday or earlier.
    expect(lists()).toEqual(['Today', 'This week']);
    expect(titles(screen.getByRole('list', { name: 'Today' }))).toEqual([
      'Live viewer research (demo)',
      'Fix flaky login test',
    ]);
    // A time group folds like a project, by its own key.
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    expect(onPrefs).toHaveBeenLastCalledWith(
      expect.objectContaining({ folded: ['/week'], groupBy: 'time' }),
    );
    expect(lists()).toEqual(['Today']);
    fireEvent.click(within(by).getByRole('radio', { name: 'Project' }));
    expect(lists()).toEqual(['glassbox', 'shopfront', 'blog']);
  });

  it('names the time groups in Chinese', () => {
    render(
      <Harness sessions={sessions} locale="zh" prefs={{ ...DEFAULT_PREFS, groupBy: 'time' }} />,
    );
    expect(screen.getByRole('radiogroup', { name: '分组' })).toBeInTheDocument();
    expect(lists()).toEqual(['今天', '本周']);
  });
});
