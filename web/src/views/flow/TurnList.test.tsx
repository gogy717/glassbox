import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import postcss from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Turn } from '../../../../src/core/model.js';
import { I18nContext, makeI18n } from '../../i18n';
import { moduleCssValue } from '../../test/module-css';
import type { SearchGroup, SearchHit } from './search';
import type { SearchScope } from './search-prefs';
import { newestMatch, type TurnItem, TurnList } from './TurnList';
import listCss from './TurnList.module.css';

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
    label: `Prompt ${n}`,
    title: `prompt ${n}`,
    prompt: `prompt ${n}`,
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
    const cards = within(screen.getByRole('list', { name: 'Prompts' })).getAllByRole('button');
    expect(cards.map((c) => c.querySelector('[data-title]')?.textContent)).toEqual([
      'prompt 5',
      'prompt 4',
      'prompt 3',
      'prompt 2',
      'prompt 1',
    ]);
    // The number column is what the eye reads; the row's name says the words.
    expect(cards[0]).toHaveAccessibleName(/^Prompt 5\s*prompt 5/);
    expect(cards.map((c) => c.querySelector('[aria-hidden="true"]')?.textContent)).toEqual([
      '5',
      '4',
      '3',
      '2',
      '1',
    ]);
    expect(cards[0]).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('navigation', { name: 'Prompts' })).toHaveTextContent('5');
  });

  it('selects the turn that was clicked, not its position', () => {
    const { onSelect } = renderList('turn_5');
    fireEvent.click(screen.getByRole('button', { name: /Prompt 2/ }));
    expect(onSelect).toHaveBeenCalledWith('turn_2');
  });

  it('scrolls the list, and only the list, to a selected turn out of view', () => {
    const { select } = renderList('turn_5');
    const list = screen.getByRole('list', { name: 'Prompts' });
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
    const scrolled = layOut(screen.getByRole('list', { name: 'Prompts' }));
    select('turn_4');
    expect(scrolled).toEqual({ top: 0, left: 0 });
  });

  it('is one tab stop, at the selected turn, and the arrow keys move through the rest', () => {
    renderList('turn_3');
    const cards = within(screen.getByRole('list', { name: 'Prompts' })).getAllByRole('button');
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
    const cards = within(screen.getByRole('list', { name: 'Prompts' })).getAllByRole('button');
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
    const other = screen.getByRole('button', { name: /Prompt 5/ });
    expect(other).toHaveTextContent('1 call · 0 tools');
    fireEvent.click(card);
    expect(onSelect).toHaveBeenCalledWith('turn_6');
  });
});

describe('TurnList days', () => {
  // Every instant is noon UTC: one calendar day in any zone short of the far Pacific, so the
  // headings do not depend on where the tests run.
  const on = (n: number, iso: string): TurnItem => ({
    ...item(n),
    turn: { ...item(n).turn, startedAt: new Date(Date.parse(iso)).toISOString() },
  });
  const rowsOf = () =>
    [...screen.getByRole('list', { name: /Prompts|用户轮次/ }).children].map(
      (li) => li.querySelector('[data-title]')?.textContent ?? li.textContent,
    );
  const renderDays = (items: TurnItem[], locale: 'en' | 'zh' = 'en') =>
    render(
      <I18nContext.Provider value={makeI18n(locale)}>
        <TurnList items={items} selectedId="turn_5" onSelect={vi.fn()} />
      </I18nContext.Provider>,
    );

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('heads each day where the day changes: today, yesterday, then the date', () => {
    renderDays([
      on(1, '2026-10-23T12:01:00Z'),
      on(2, '2026-10-23T12:02:00Z'),
      on(3, '2026-10-25T12:00:00Z'),
      on(4, '2026-10-26T12:04:00Z'),
      on(5, '2026-10-26T12:05:00Z'),
    ]);
    expect(rowsOf()).toEqual([
      'Today',
      'prompt 5',
      'prompt 4',
      'Yesterday',
      'prompt 3',
      'Oct 23',
      'prompt 2',
      'prompt 1',
    ]);
    // A heading is not a stop: the arrow keys move from prompt to prompt.
    const list = screen.getByRole('list', { name: 'Prompts' });
    expect(within(list).getAllByRole('button')).toHaveLength(5);
    expect(list.querySelectorAll('[data-roving]')).toHaveLength(5);
  });

  it('writes the year for a day of another year, in Chinese too', () => {
    const items = [on(1, '2025-12-31T12:00:00Z'), on(5, '2026-10-26T12:00:00Z')];
    renderDays(items);
    expect(rowsOf()).toEqual(['Today', 'prompt 5', 'Dec 31, 2025', 'prompt 1']);
    cleanup();
    renderDays(items, 'zh');
    expect(rowsOf()).toEqual(['今天', 'prompt 5', '2025年12月31日', 'prompt 1']);
  });

  it('heads nothing while every prompt is from one day', () => {
    renderDays([1, 2, 3, 4, 5].map((n) => on(n, `2026-10-26T12:0${n}:00Z`)));
    expect(rowsOf()).toEqual(['prompt 5', 'prompt 4', 'prompt 3', 'prompt 2', 'prompt 1']);
  });
});

describe('TurnList commands', () => {
  afterEach(cleanup);

  const command = (n: number, prompt: string): TurnItem => ({
    ...item(n),
    turn: { ...item(n).turn, prompt },
    title: prompt,
    prompt,
    calls: 0,
    command: true,
  });
  const run = [
    item(1),
    command(2, '/model opus'),
    command(3, '/effort high'),
    command(4, '/clear'),
    item(5),
  ];
  const renderRun = (selectedId: string, items = run, onSelect = vi.fn()) => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <TurnList items={items} selectedId={selectedId} onSelect={onSelect} />
      </I18nContext.Provider>,
    );
    return onSelect;
  };
  const buttons = () =>
    within(screen.getByRole('list', { name: 'Prompts' })).getAllByRole('button');

  it('folds two or more local commands in a row into one line, which opens on a click', () => {
    const onSelect = renderRun('turn_5');
    const fold = screen.getByRole('button', { name: /3 commands/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(fold).toHaveAttribute('data-command');
    expect(fold.querySelector('[data-title]')).toHaveTextContent(
      '/clear · /effort high · /model opus',
    );
    expect(fold).toHaveAttribute('title', '/clear\n/effort high\n/model opus');
    // Five prompts, three of them folded: three lines.
    expect(screen.queryByRole('button', { name: /^\/effort/ })).toBeNull();
    expect(buttons()).toHaveLength(3);
    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(buttons()).toHaveLength(6);
    const effort = screen.getByRole('button', { name: /^\/effort high/ });
    expect(effort).toHaveAttribute('data-folded');
    expect(effort).toHaveAttribute('data-command');
    fireEvent.click(effort);
    expect(onSelect).toHaveBeenCalledWith('turn_3');
    // Opened, the line names the run alone: its commands are the rows under it.
    expect(fold.querySelector('[data-title]')).toHaveTextContent('');
    fireEvent.click(fold);
    expect(buttons()).toHaveLength(3);
  });

  it('opens the fold that holds the selected prompt', () => {
    renderRun('turn_3');
    expect(screen.getByRole('button', { name: /3 commands/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('button', { name: /^\/effort high/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('leaves a lone command as its own line', () => {
    renderRun('turn_5', [item(1), command(2, '/model opus'), item(5)]);
    expect(screen.queryByRole('button', { name: /commands/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^\/model opus/ })).not.toHaveAttribute(
      'data-folded',
    );
    expect(buttons()).toHaveLength(3);
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
    within(screen.getByRole('list', { name: 'Prompts' }))
      .getAllByRole('button')
      .map((b) => b.querySelector('[data-title]')?.textContent);

  it('keeps the prompts whose heading matches, newest first, and counts them', () => {
    const { type, onQuery } = renderFiltered();
    const field = screen.getByRole('searchbox', { name: 'Filter prompts' });
    fireEvent.change(field, { target: { value: 'prompt 2' } });
    expect(onQuery).toHaveBeenLastCalledWith('prompt 2');
    type('PROMPT');
    expect(titles()).toEqual(['prompt 5', 'prompt 4', 'prompt 3', 'prompt 2', 'prompt 1']);
    type('prompt 2');
    expect(titles()).toEqual(['prompt 2']);
    expect(screen.getByRole('navigation', { name: 'Prompts' })).toHaveTextContent('1 of 5');
    // The number the row shows matches too: "Prompt 4".
    type('prompt 4');
    expect(titles()).toEqual(['prompt 4']);
  });

  it('says so when nothing matches, and clears with Escape', () => {
    const { type, onQuery } = renderFiltered('nothing like this');
    expect(screen.getByText('No prompt matches')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Prompts' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(onQuery).toHaveBeenLastCalledWith('');
    type('');
    expect(titles()).toHaveLength(5);
  });

  it('is the tab stop before the list', () => {
    renderFiltered();
    const field = screen.getByRole('searchbox', { name: 'Filter prompts' });
    const list = screen.getByRole('list', { name: 'Prompts' });
    expect(field.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has no field where the view does not ask for one', () => {
    renderList('turn_5');
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});

describe('TurnList search', () => {
  afterEach(cleanup);

  const hit = (over: Partial<SearchHit>): SearchHit => ({
    kind: 'prompt',
    tool: null,
    requestId: null,
    card: null,
    before: '',
    match: 'login',
    after: '',
    ...over,
  });
  const results: SearchGroup[] = [
    {
      turn: item(2).turn,
      hits: [
        hit({ kind: 'prompt', before: 'Fix the flaky ', after: ' test' }),
        hit({ kind: 'tool', tool: 'Bash', requestId: 'r1', card: 'tool:tu1', after: '.spec.ts' }),
        hit({ kind: 'result', tool: 'Bash', requestId: 'r1', card: 'tool:tu1', before: 'FAIL ' }),
      ],
    },
    {
      turn: item(4).turn,
      hits: [hit({ kind: 'reply', requestId: 'r7', card: 'response', before: '…the ' })],
    },
  ];

  function renderSearch(
    over: {
      scope?: SearchScope;
      query?: string;
      results?: SearchGroup[] | null;
      selectedId?: string | null;
      openCard?: { requestId: string; card: `tool:${string}` | 'response' } | null;
      locale?: 'en' | 'zh';
    } = {},
  ) {
    const on = { select: vi.fn(), query: vi.fn(), scope: vi.fn(), hit: vi.fn() };
    render(
      <I18nContext.Provider value={makeI18n(over.locale ?? 'en')}>
        <TurnList
          items={items}
          selectedId={over.selectedId ?? 'turn_5'}
          onSelect={on.select}
          query={over.query ?? 'login'}
          onQuery={on.query}
          scope={over.scope ?? 'everything'}
          onScope={on.scope}
          results={over.results === undefined ? results : over.results}
          onHit={on.hit}
          openCard={over.openCard ?? null}
        />
      </I18nContext.Provider>,
    );
    return on;
  }

  const resultList = () => screen.getByRole('list', { name: 'Search results' });

  it('offers Titles or Everything under the field, and says which one it searches', () => {
    const on = renderSearch({ scope: 'titles', results: null });
    const choice = screen.getByRole('radiogroup', { name: 'Search in' });
    expect(within(choice).getByRole('radio', { name: 'Titles' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('searchbox', { name: 'Filter prompts' })).toBeInTheDocument();
    fireEvent.click(within(choice).getByRole('radio', { name: 'Everything' }));
    expect(on.scope).toHaveBeenCalledWith('everything');
    cleanup();
    renderSearch();
    expect(screen.getByRole('searchbox', { name: 'Search everything' })).toBeInTheDocument();
  });

  it('has no choice where the view does not ask for one', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <TurnList items={items} selectedId="turn_5" onSelect={vi.fn()} query="" onQuery={vi.fn()} />
      </I18nContext.Provider>,
    );
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('lists the hits by prompt, newest first, each typed, its match marked, and counts them', () => {
    renderSearch();
    expect(screen.queryByRole('list', { name: 'Prompts' })).toBeNull();
    const groups = [...resultList().children] as HTMLElement[];
    // Each group's head: the prompt, its hits, then its title.
    const heads = groups.map((g) => g.querySelector('[data-group]'));
    expect(heads).toHaveLength(2);
    expect(heads[0]).toHaveAccessibleName(/^Prompt 4 · 1 hit\W+prompt 4$/);
    expect(heads[1]).toHaveAccessibleName(/^Prompt 2 · 3 hits\W+prompt 2$/);
    const lines = within(groups[1] as HTMLElement)
      .getAllByRole('button')
      .slice(1);
    expect(lines.map((b) => b.querySelector('[data-kind]')?.textContent)).toEqual([
      'Prompt',
      'Bash',
      'Result',
    ]);
    expect(lines[0]).toHaveTextContent('Fix the flaky login test');
    expect(lines.map((b) => b.querySelector('mark')?.textContent)).toEqual([
      'login',
      'login',
      'login',
    ]);
    // A result says whose it is, where the line has no room for it.
    expect(lines[2]?.querySelector('[data-kind]')).toHaveAttribute('title', 'Bash result');
    // Where the search cut the words before the match, its "…" stands apart from them, ahead of
    // the box that cuts them further when the line is short of room.
    const reply = within(groups[0] as HTMLElement).getAllByRole('button')[1] as HTMLElement;
    expect(reply).toHaveTextContent('…the login');
    expect(reply.querySelector('[data-cut]')).toHaveTextContent(/^…$/);
    expect(reply.querySelector('[data-cut]')?.nextElementSibling?.textContent).toBe('the ');
    expect(lines[0]?.querySelector('[data-cut]')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Prompts' })).toHaveTextContent('4 hits');
  });

  it('opens a hit where it is, and a group’s prompt from its head', () => {
    const on = renderSearch();
    fireEvent.click(screen.getByRole('button', { name: /^Bash/ }));
    expect(on.hit).toHaveBeenCalledWith(results[0]?.hits[1], 'turn_2');
    fireEvent.click(screen.getByRole('button', { name: /^Prompt 4 · 1 hit/ }));
    expect(on.select).toHaveBeenCalledWith('turn_4');
  });

  it('marks the open prompt’s group and the hit whose card is open', () => {
    renderSearch({ selectedId: 'turn_2', openCard: { requestId: 'r1', card: 'tool:tu1' } });
    expect(screen.getByRole('button', { name: /^Prompt 2 · 3 hits/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    const current = within(resultList())
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-current') === 'true');
    // The group, and the tool's input and result: the card open shows both.
    expect(current.map((b) => b.querySelector('[data-kind]')?.textContent ?? 'group')).toEqual([
      'group',
      'Bash',
      'Result',
    ]);
  });

  it('is one tab stop, the arrow keys moving over the heads and the hits', () => {
    renderSearch({ selectedId: 'turn_2' });
    const stops = within(resultList()).getAllByRole('button');
    expect(stops.map((b) => b.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1]);
    const head = stops[2] as HTMLElement;
    head.focus();
    fireEvent.keyDown(head, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(stops[3]);
  });

  it('hides the prompt list under the results, whatever display its own rules give it', () => {
    renderSearch();
    // Hidden, it has no accessible name to be found by.
    const list = document.querySelector(`ul.${listCss.list}`) as HTMLElement;
    expect(list).toHaveAttribute('hidden');
    // jsdom applies no module CSS: the module's rules, matched on the list, must say none.
    const sheet = join(import.meta.dirname, 'TurnList.module.css');
    expect(moduleCssValue(sheet, listCss, list, 'display')).toBe('none');
  });

  it('brings the open prompt into view once a search that hid the list is cleared', () => {
    const tree = (shown: SearchGroup[] | null) => (
      <I18nContext.Provider value={makeI18n('en')}>
        <TurnList
          items={items}
          selectedId="turn_1"
          onSelect={vi.fn()}
          query="login"
          onQuery={vi.fn()}
          scope="everything"
          onScope={vi.fn()}
          results={shown}
          onHit={vi.fn()}
        />
      </I18nContext.Provider>
    );
    // A hit opened prompt 1 while the list was hidden, and so was never laid out to show it.
    const view = render(tree(results));
    const scrolled = layOut(document.querySelector(`ul.${listCss.list}`) as HTMLElement);
    view.rerender(tree(null));
    // Prompt 1 is the fifth row, at 400–490 px in a 300 px list.
    expect(scrolled.top).toBe(490 - 300 + 10);
  });

  it('says when nothing matches, and what it searched', () => {
    renderSearch({ results: [] });
    expect(screen.getByText('Nothing matches')).toBeInTheDocument();
    expect(
      screen.getByText('Searches what is on the page; full tool results are not loaded'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('lists every prompt while the words are too short to search, saying from how many it does', () => {
    renderSearch({ query: 'p', results: null });
    expect(screen.getByText('Search starts at two characters')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Prompts' })).getAllByRole('button'),
    ).toHaveLength(5);
    cleanup();
    renderSearch({ query: '', results: null });
    expect(screen.queryByText('Search starts at two characters')).toBeNull();
  });

  it('words a search in Chinese', () => {
    renderSearch({ locale: 'zh' });
    expect(screen.getByRole('radiogroup', { name: '搜索范围' })).toHaveTextContent('标题全部内容');
    // The items carry their labels ("Prompt 2" in this fixture); the count is the list's own.
    expect(screen.getByRole('button', { name: /^Prompt 2 · 3 处匹配/ })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '用户轮次' })).toHaveTextContent('4 处匹配');
    expect(screen.getByRole('searchbox', { name: '搜索全部内容' })).toBeInTheDocument();
  });
});

describe('newestMatch', () => {
  const items = [item(1), item(2), item(12)];

  it('is the newest turn whose label or prompt has the words, any case', () => {
    expect(newestMatch(items, 'PROMPT 1')?.turn.index).toBe(12);
    expect(newestMatch(items, 'prompt 2')?.turn.index).toBe(2);
  });

  it('is the newest of all for no words, and nothing when none matches', () => {
    expect(newestMatch(items, '  ')?.turn.index).toBe(12);
    expect(newestMatch(items, 'nothing like it')).toBeUndefined();
  });
});

describe('TurnList styles', () => {
  it('keeps search results to part of a narrow page, so the calls under them stay in view', () => {
    // At 900 px and under the list sits in an auto row above the calls: uncapped, a long list
    // of hits would grow that row and leave the calls no height.
    const sheet = readFileSync(join(import.meta.dirname, 'SearchResults.module.css'), 'utf8');
    const caps: string[] = [];
    postcss.parse(sheet).walkAtRules('media', (media) => {
      if (/max-width:\s*900px/.test(media.params))
        media.walkRules('.results', (r) =>
          r.walkDecls('max-height', (d) => {
            caps.push(d.value);
          }),
        );
    });
    expect(caps).toHaveLength(1);
    expect(caps[0]).not.toBe('none');
  });

  // jsdom has no layout. The utility is safe on its own (global.test.ts); the row also holds its
  // hidden words, so a screen reader's cursor lands on the row it reads.
  it('contains each row’s visually hidden text, so the scrolling list cannot widen the page', () => {
    const sheet = readFileSync(join(import.meta.dirname, 'TurnList.module.css'), 'utf8');
    const row = /\n\.row \{([^}]*)\}/.exec(sheet)?.[1] ?? '';
    expect(row).toMatch(/position: relative;/);
  });

  it("pushes a row's mark to its right edge, so the marks make a column under the clocks", () => {
    const sheet = readFileSync(join(import.meta.dirname, 'TurnList.module.css'), 'utf8');
    const mark = /\n\.markSub \{([^}]*)\}/.exec(sheet)?.[1];
    expect(mark).toMatch(/margin-left: auto;/);
  });

  it('keeps the "local command" note (本地命令) out of the mono face', () => {
    const sheet = readFileSync(join(import.meta.dirname, 'TurnList.module.css'), 'utf8');
    const note = /\n\.command \{([^}]*)\}/.exec(sheet)?.[1];
    expect(note).toBeDefined();
    expect(note).not.toMatch(/font-family/);
  });

  it('keeps a local command to one line: its note and clock share the row with the command', () => {
    const sheet = readFileSync(join(import.meta.dirname, 'TurnList.module.css'), 'utf8');
    const row = /\n\.row\[data-command\] \{([^}]*)\}/.exec(sheet)?.[1];
    expect(row).toMatch(/grid-template-columns: 14px minmax\(0, 1fr\) auto auto;/);
    expect(/\n\.command \{([^}]*)\}/.exec(sheet)?.[1]).toMatch(/grid-row: 1;/);
    expect(/\n\.row\[data-command\] \.clock \{([^}]*)\}/.exec(sheet)?.[1]).toMatch(
      /grid-column: 4;/,
    );
  });
});
