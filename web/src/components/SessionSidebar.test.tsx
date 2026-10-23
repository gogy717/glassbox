import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoSessions } from '../../../src/core/fixtures/demo.js';
import { I18nContext, makeI18n } from '../i18n';
import { DEMO_NOW } from '../test/demo';
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
  it('marks each session with its agent only when more than one agent has sessions', () => {
    const mixed = sessions.map((s, i) => (i === 1 ? { ...s, agent: 'grok' } : s));
    const { rerender } = render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={mixed}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    const items = screen.getAllByRole('button').filter((b) => b.closest('li'));
    expect(items.filter((b) => b.querySelector('[data-agent="grok"]'))).toHaveLength(1);
    expect(items.filter((b) => b.querySelector('[data-agent="claude-code"]')).length).toBe(
      sessions.length - 1,
    );
    expect(within(items[1] as HTMLElement).getByText('Grok')).toBeInTheDocument();

    rerender(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionSidebar
          sessions={sessions}
          selectedId={null}
          now={DEMO_NOW.getTime()}
          onSelect={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    expect(document.querySelector('[data-agent]')).toBeNull();
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
