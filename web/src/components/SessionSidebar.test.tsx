import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoSessions } from '../../../src/core/fixtures/demo.js';
import type { SessionSummary } from '../../../src/core/model.js';
import { I18nContext, makeI18n } from '../i18n';
import { DEMO_NOW } from '../test/demo';
import tagCss from './AgentTag.module.css';
import { SessionSidebar } from './SessionSidebar';
import css from './SessionSidebar.module.css';

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
    expect(chips.map((c) => c.textContent)).toEqual(['Claude Code', 'Grok']);
    const rows = () => screen.getAllByRole('button').filter((b) => b.closest('li'));
    expect(rows()).toHaveLength(sessions.length);

    const grok = within(group).getByRole('button', { name: 'Grok' });
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
    ).toEqual(['Claude Code', 'Grok', 'aider']);
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
    ).toEqual(['Claude Code', 'Grok']);
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
    fireEvent.click(within(group).getByRole('button', { name: 'Grok' }));
    const rows = screen.getAllByRole('button').filter((b) => b.closest('li'));
    expect(rows).toHaveLength(2);
    expect(rows.find((b) => b.getAttribute('aria-current') === 'true')).toHaveTextContent(
      open.title ?? '',
    );
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
    fireEvent.click(within(group).getByRole('button', { name: 'Grok' }));
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
    expect(row).toHaveClass(css.item as string);
    // Nothing cut short (jsdom lays nothing out): the tooltip only adds the folder, so a screen
    // reader does not hear the row's text twice.
    fireEvent.pointerEnter(row);
    expect(row).toHaveAttribute('title', long.cwd);
    // Cut short: the tooltip has all of it.
    const title = row.querySelector<HTMLElement>(`.${css.title}`) as HTMLElement;
    Object.defineProperty(title, 'scrollWidth', { configurable: true, value: 400 });
    Object.defineProperty(title, 'clientWidth', { configurable: true, value: 200 });
    fireEvent.pointerEnter(row);
    const tip = (row.getAttribute('title') ?? '').split('\n');
    expect(tip[0]).toBe(long.title);
    expect(tip[1]).toMatch(/^Claude Code · Running · .+ · 1\.9M tokens$/);
    expect(tip[2]).toBe(long.cwd);
    // Time and tokens sit in the part that gives way first.
    expect(row.querySelector(`.${css.when}`)).toHaveTextContent(/1\.9M tokens/);
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
    expect(within(busy).getByText('1.9M tokens')).toBeInTheDocument();
    const untitled = screen.getByRole('button', { name: /Untitled session/ });
    expect(within(untitled).getByText('Closed')).toBeInTheDocument();
    expect(within(untitled).queryByText(/tokens/)).toBeNull();
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
});
