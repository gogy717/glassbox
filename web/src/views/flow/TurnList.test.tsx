import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Turn } from '../../../../src/core/model.js';
import { I18nContext, makeI18n } from '../../i18n';
import { type TurnItem, TurnList } from './TurnList';

function item(n: number): TurnItem {
  const turn = {
    id: `turn_${n}`,
    agentId: 'main',
    index: n,
    origin: 'human',
    prompt: `prompt ${n}`,
    startedAt: new Date(Date.UTC(2026, 9, 24, 1, n)).toISOString(),
    endedAt: null,
    status: 'complete',
    requestIds: [],
  } as Turn;
  return {
    turn,
    label: `Conversation ${n}`,
    title: `prompt ${n}`,
    prompt: `prompt ${n}`,
    heading: `Conversation ${n}: prompt ${n}`,
    calls: 1,
    tools: 0,
    status: 'complete',
    command: false,
  };
}

const items = [1, 2, 3, 4, 5].map(item);

function renderList(selectedId: string | null, onSelect = vi.fn()) {
  const tree = (id: string | null) => (
    <I18nContext.Provider value={makeI18n('en')}>
      <TurnList items={items} selectedId={id} onSelect={onSelect} />
    </I18nContext.Provider>
  );
  const view = render(tree(selectedId));
  return { ...view, select: (id: string | null) => view.rerender(tree(id)), onSelect };
}

/** Places the list at `[0, 300)` and turn `n`'s card at `[100 n, 100 n + 90)`, top to bottom. */
function layOut(list: HTMLElement, scrolled = { top: 0, left: 0 }) {
  const rect = (top: number, height: number, left = 0, width = 200) =>
    DOMRect.fromRect({ x: left, y: top, width, height });
  list.getBoundingClientRect = () => rect(0, 300);
  Object.defineProperty(list, 'scrollTop', {
    configurable: true,
    get: () => scrolled.top,
    set: (v: number) => {
      scrolled.top = Math.max(0, v);
    },
  });
  Object.defineProperty(list, 'scrollLeft', {
    configurable: true,
    get: () => scrolled.left,
    set: (v: number) => {
      scrolled.left = Math.max(0, v);
    },
  });
  [...list.children].forEach((li, i) => {
    (li as HTMLElement).getBoundingClientRect = () => rect(i * 100 - scrolled.top, 90);
  });
  return scrolled;
}

describe('TurnList', () => {
  afterEach(cleanup);

  it('shows the newest turn first and keeps chronological numbers', () => {
    renderList('turn_5');
    const cards = within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole(
      'button',
    );
    expect(cards.map((c) => c.querySelector('[data-title]')?.textContent)).toEqual([
      'prompt 5',
      'prompt 4',
      'prompt 3',
      'prompt 2',
      'prompt 1',
    ]);
    // The number column is what the eye reads; the row's name says the words.
    expect(cards[0]).toHaveAccessibleName(/^Conversation 5\s*prompt 5/);
    expect(cards.map((c) => c.querySelector('[aria-hidden="true"]')?.textContent)).toEqual([
      '5',
      '4',
      '3',
      '2',
      '1',
    ]);
    expect(cards[0]).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('navigation', { name: 'Conversations' })).toHaveTextContent('5');
  });

  it('selects the turn that was clicked, not its position', () => {
    const { onSelect } = renderList('turn_5');
    fireEvent.click(screen.getByRole('button', { name: /Conversation 2/ }));
    expect(onSelect).toHaveBeenCalledWith('turn_2');
  });

  it('scrolls the list, and only the list, to a selected turn out of view', () => {
    const { select } = renderList('turn_5');
    const list = screen.getByRole('list', { name: 'Conversations' });
    const scrolled = layOut(list);

    // Turn 1 is the fifth card, at 400–490 px in a 300 px list: scroll it into view.
    select('turn_1');
    expect(scrolled.top).toBe(490 - 300 + 10);

    // Back to the newest (follow): the top card comes back into view.
    layOut(list, scrolled);
    select('turn_5');
    expect(scrolled.top).toBe(0);
  });

  it('leaves the scroll alone when the selected turn is already in view', () => {
    const { select } = renderList('turn_5');
    const scrolled = layOut(screen.getByRole('list', { name: 'Conversations' }));
    select('turn_4');
    expect(scrolled).toEqual({ top: 0, left: 0 });
  });

  it('is one tab stop, at the selected turn, and the arrow keys move through the rest', () => {
    renderList('turn_3');
    const cards = within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole(
      'button',
    );
    expect(cards.map((c) => c.tabIndex)).toEqual([-1, -1, 0, -1, -1]);

    const third = cards[2] as HTMLElement;
    third.focus();
    fireEvent.keyDown(third, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cards[3]);
    // The tab stop follows focus, so Tab out and back returns here.
    expect(cards.map((c) => c.tabIndex)).toEqual([-1, -1, -1, 0, -1]);

    fireEvent.keyDown(cards[3] as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(cards[4]);
    fireEvent.keyDown(cards[4] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cards[4]);
    fireEvent.keyDown(cards[4] as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(cards[0]);
    fireEvent.keyDown(cards[0] as HTMLElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cards[0]);
    fireEvent.keyDown(cards[0] as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cards[1]);
  });

  it('puts the tab stop on the newest turn when nothing is selected', () => {
    renderList(null);
    const cards = within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole(
      'button',
    );
    expect(cards[0]).toHaveAttribute('tabindex', '0');
    expect(cards.filter((c) => c.tabIndex === 0)).toHaveLength(1);
  });

  it('lists a local slash command as one slim line, still selectable', () => {
    const onSelect = vi.fn();
    const command: TurnItem = {
      ...item(6),
      turn: { ...item(6).turn, prompt: '/effort' },
      title: '/effort',
      calls: 0,
      command: true,
    };
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <TurnList items={[...items, command]} selectedId="turn_5" onSelect={onSelect} />
      </I18nContext.Provider>,
    );
    const card = screen.getByRole('button', { name: /^\/effort/ });
    expect(card.querySelector('[data-title]')).toHaveTextContent(/^\/effort$/);
    expect(card).toHaveAttribute('data-command');
    expect(within(card).getByText('local command')).toBeInTheDocument();
    // The explanation is part of the card's text, so keyboard and screen-reader users get it too.
    expect(card).toHaveAccessibleName(/Run by Claude Code itself; the model was not called/);
    expect(within(card).queryByText(/model call/)).toBeNull();
    expect(within(card).queryByText('Complete')).toBeNull();
    // Ordinary turns keep their counts and status.
    const other = screen.getByRole('button', { name: /Conversation 5/ });
    expect(other).toHaveTextContent('1 call · 0 tools');
    fireEvent.click(card);
    expect(onSelect).toHaveBeenCalledWith('turn_6');
  });
});

describe('TurnList filter', () => {
  afterEach(cleanup);

  function renderFiltered(initial = '') {
    const onQuery = vi.fn();
    const tree = (query: string) => (
      <I18nContext.Provider value={makeI18n('en')}>
        <TurnList
          items={items}
          selectedId="turn_5"
          onSelect={vi.fn()}
          query={query}
          onQuery={onQuery}
        />
      </I18nContext.Provider>
    );
    const view = render(tree(initial));
    return { ...view, onQuery, type: (q: string) => view.rerender(tree(q)) };
  }

  const titles = () =>
    within(screen.getByRole('list', { name: 'Conversations' }))
      .getAllByRole('button')
      .map((b) => b.querySelector('[data-title]')?.textContent);

  it('keeps the conversations whose heading matches, newest first, and counts them', () => {
    const { type, onQuery } = renderFiltered();
    const field = screen.getByRole('searchbox', { name: 'Filter conversations' });
    fireEvent.change(field, { target: { value: 'prompt 2' } });
    expect(onQuery).toHaveBeenLastCalledWith('prompt 2');
    type('PROMPT');
    expect(titles()).toEqual(['prompt 5', 'prompt 4', 'prompt 3', 'prompt 2', 'prompt 1']);
    type('prompt 2');
    expect(titles()).toEqual(['prompt 2']);
    expect(screen.getByRole('navigation', { name: 'Conversations' })).toHaveTextContent('1 of 5');
    // The number the row shows matches too: "Conversation 4".
    type('conversation 4');
    expect(titles()).toEqual(['prompt 4']);
  });

  it('says so when nothing matches, and clears with Escape', () => {
    const { type, onQuery } = renderFiltered('nothing like this');
    expect(screen.getByText('No conversation matches')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Conversations' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(onQuery).toHaveBeenLastCalledWith('');
    type('');
    expect(titles()).toHaveLength(5);
  });

  it('is the tab stop before the list', () => {
    renderFiltered();
    const field = screen.getByRole('searchbox', { name: 'Filter conversations' });
    const list = screen.getByRole('list', { name: 'Conversations' });
    expect(field.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has no field where the view does not ask for one', () => {
    renderList('turn_5');
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});
