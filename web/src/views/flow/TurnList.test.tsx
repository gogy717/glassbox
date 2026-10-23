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
    title: `Conversation ${n}: prompt ${n}`,
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
      'Conversation 5: prompt 5',
      'Conversation 4: prompt 4',
      'Conversation 3: prompt 3',
      'Conversation 2: prompt 2',
      'Conversation 1: prompt 1',
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
      title: 'Conversation 6: /effort',
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
    expect(within(other).getByText('1 model call · 0 tools')).toBeInTheDocument();
    fireEvent.click(card);
    expect(onSelect).toHaveBeenCalledWith('turn_6');
  });
});
