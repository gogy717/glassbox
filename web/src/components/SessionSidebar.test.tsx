import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDemoSessions } from '../../../src/core/fixtures/demo.js';
import type { SessionSummary } from '../../../src/core/model.js';
import { I18nContext, makeI18n } from '../i18n';
import { DEMO_NOW } from '../test/demo';
import tagCss from './AgentTag.module.css';
import { WAIT_MS } from './Delayed';
import rowCss from './SessionRow.module.css';
import { SessionSidebar } from './SessionSidebar';

const sessions = createDemoSessions(DEMO_NOW);

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
    const items = screen.getAllByRole('button').filter((b) => b.closest('li'));
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
    const rows = () => screen.getAllByRole('button').filter((b) => b.closest('li'));
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
    const rows = screen.getAllByRole('button').filter((b) => b.closest('li'));
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
    const rows = screen.getAllByRole('button').filter((b) => b.closest('li'));
    expect(rows).toHaveLength(sessions.length - 1);
    // One stop, on the first row the filter left.
    expect(rows.map((r) => r.tabIndex)).toEqual(rows.map((_, i) => (i === 0 ? 0 : -1)));
    (rows[0] as HTMLElement).focus();
    fireEvent.keyDown(rows[0] as HTMLElement, { key: 'ArrowDown' });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1] as HTMLElement, { key: 'End' });
    expect(rows.at(-1)).toHaveFocus();
    // Back to every agent: the stop stays on the row last focused.
    fireEvent.click(within(group).getByRole('button', { name: /^Grok/ }));
    const all = screen.getAllByRole('button').filter((b) => b.closest('li'));
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
    expect(screen.getAllByRole('button').filter((b) => b.closest('li'))).toHaveLength(1);
    rerender(sidebar(sessions));
    expect(screen.getAllByRole('button').filter((b) => b.closest('li'))).toHaveLength(
      sessions.length,
    );
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
    expect(screen.getByText('等你确认')).toBeInTheDocument();
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
    const items = screen.getAllByRole('button').filter((b) => b.closest('li'));
    expect(items.filter((b) => b.tabIndex === 0)).toEqual([
      screen.getByRole('button', { name: /Live viewer research/ }),
    ]);
    const first = items[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    // The next session sits in another project's group.
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
    const rows = () => screen.getAllByRole('button').filter((b) => b.closest('li'));

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
    expect(screen.getAllByRole('button').filter((b) => b.closest('li'))).toHaveLength(
      sessions.length,
    );
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
    expect(screen.getAllByRole('button').filter((b) => b.closest('li'))).toHaveLength(
      sessions.length,
    );
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
    expect(screen.getAllByRole('button').filter((b) => b.closest('li'))).toHaveLength(three.length);
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
