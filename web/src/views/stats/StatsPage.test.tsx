import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../../../../src/core/model.js';
import type { WeekLine, WeekResult, WeekWindowKind } from '../../../../src/shared/week.js';
import { durationParts, partsText } from '../../components/receipt/format';
import { createStore, type Store, StoreContext } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import { sessionLink } from '../../router';
import { demoWeek, WEEK_NOW } from '../../test/week';
import { StatsPage } from './StatsPage';
import { busiestCell, hourOfCell, hourSpan, statsWeek } from './statsData';

/** A streamed /api/week answer: the result, after a progress line. */
const answer = (result: WeekResult) => {
  const lines: WeekLine[] = [
    { type: 'progress', done: 1, total: 2 },
    { type: 'result', result },
  ];
  return new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
};

/**
 * fetch answering /api/week from `results` by window; the URLs it saw. `next` changes how the
 * next requests are answered: held (never), failed (HTTP 500), or as given.
 */
function serve(results: { week?: WeekResult; d7?: WeekResult }) {
  const calls: string[] = [];
  let mode: 'answer' | 'hold' | 'fail' = 'answer';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (mode === 'hold') return new Promise<Response>(() => {});
      const r = url.includes('window=7d') ? results.d7 : results.week;
      if (mode === 'fail' || !r) return new Response('nope', { status: 500 });
      return answer(r);
    }),
  );
  return { calls, next: (m: typeof mode) => (mode = m) };
}

const week = demoWeek('week');
const d7 = demoWeek('7d');

function page(
  store: Store,
  kind: WeekWindowKind = 'week',
  sessions: SessionSummary[] = [],
  onWindow = vi.fn(),
) {
  return (
    <StoreContext.Provider value={store}>
      <I18nContext.Provider value={makeI18n('en')}>
        <StatsPage
          window={kind}
          onWindow={onWindow}
          showProbes={false}
          sessions={sessions}
          quotas={[]}
          now={WEEK_NOW}
        />
      </I18nContext.Provider>
    </StoreContext.Provider>
  );
}

const overview = () => screen.getByRole('region', { name: 'Summary' });
const hourTitle = () => document.getElementById('stats-hour')?.textContent;
const time = (ms: number) => partsText(durationParts(ms, 'en'));

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(WEEK_NOW);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the Stats page (D4)', () => {
  it('prints the weekly receipt’s own figures, which its Print dialog prints too (N6)', async () => {
    serve({ week });
    const w = statsWeek(week, false);
    render(page(createStore()));
    await waitFor(() => expect(overview()).toHaveTextContent(time(w.receipt.agentMs)));
    for (const figure of [
      time(w.receipt.sessionMs),
      w.receipt.sessions.toLocaleString('en-US'),
      w.receipt.work.requests.toLocaleString('en-US'),
      w.receipt.work.toolCalls.toLocaleString('en-US'),
    ])
      expect(overview()).toHaveTextContent(figure);
    fireEvent.click(screen.getByRole('button', { name: 'Print weekly receipt' }));
    const dialog = await screen.findByRole('dialog', { name: 'Weekly receipt' });
    const text = await waitFor(() => {
      const t = dialog.querySelector('#receipt-text')?.textContent ?? '';
      expect(t).toMatch(/AGENT TIME/);
      return t;
    });
    expect(text).toContain(time(w.receipt.agentMs));
    expect(text).toContain(time(w.receipt.sessionMs));
  });

  it('shows what it read before at once on the next visit, saying it is updating', async () => {
    const { next } = serve({ week });
    const store = createStore();
    const first = render(page(store));
    await screen.findByText(/Data as of 20:41/);
    first.unmount();
    next('hold');
    render(page(store));
    // No empty cards: the figures as they were, while the week is read again.
    expect(overview()).toHaveTextContent(time(statsWeek(week, false).receipt.agentMs));
    expect(await screen.findByText(/Updating…/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Data as of 20:41 · Updating…');
  });

  it('says how far a first read got, over empty cards', async () => {
    const { next } = serve({ week });
    next('hold');
    render(page(createStore()));
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(/^Reading 0 of 0 sessions…$/);
  });

  it('selects the busiest hour, then the hour a click or the keyboard picks', async () => {
    serve({ week });
    const w = statsWeek(week, false);
    render(page(createStore()));
    const at = busiestCell(w);
    const cell = at && w.receipt.grid[at.row]?.[at.col];
    const busiest = cell && hourOfCell(w, cell);
    if (!at || busiest?.start == null) throw new Error('fixture');
    await waitFor(() => expect(hourTitle()).toBe(hourSpan(busiest.start as number, 'week', 'en')));
    const grid = screen.getByRole('table', { name: 'When the agents worked' });
    const selected = within(grid).getByRole('button', { current: true });
    expect(selected).toHaveAttribute('data-cell', `${at.row}:${at.col}`);
    expect(selected.tabIndex).toBe(0);
    // One tab stop; the arrows move it, a press shows that hour.
    act(() => selected.focus());
    const step = at.col < 23 ? 1 : -1;
    fireEvent.keyDown(selected, { key: step > 0 ? 'ArrowRight' : 'ArrowLeft' });
    const moved = document.activeElement as HTMLElement;
    expect(moved).toHaveAttribute('data-cell', `${at.row}:${at.col + step}`);
    expect(moved.tabIndex).toBe(0);
    expect(selected.tabIndex).toBe(-1);
    // A native button: Enter and Space press it, as a click does (jsdom does not press it).
    expect(moved.tagName).toBe('BUTTON');
    fireEvent.click(moved);
    const hour = (h: number) => hourSpan(h, 'week', 'en');
    expect(hourTitle()).toBe(hour(busiest.start + step * 3_600_000));
    fireEvent.click(within(grid).getAllByRole('button')[0] as HTMLElement);
    expect(hourTitle()).toMatch(/^Mon 00:00 – 01:00$/);
    // Every hour says what it held, as its tip does.
    expect(selected).toHaveAccessibleName(
      `${hour(busiest.start)} · ${time(busiest.ms)} · ${busiest.sessions.length} ${
        busiest.sessions.length === 1 ? 'session' : 'sessions'
      } · ${busiest.topCli ? `${agentNameOf(busiest.topCli.agent)} ${time(busiest.topCli.ms)}` : ''}`,
    );
  });

  it('isolates a CLI in the grid on hover, pins it on click, and lets Escape unpin it', async () => {
    serve({ week });
    const w = statsWeek(week, false);
    render(page(createStore()));
    const cli = w.receipt.byCli[1];
    if (!cli) throw new Error('fixture');
    const name = agentNameOf(cli.agent);
    const row = await screen.findByRole('button', { name: new RegExp(`^${name}`) });
    const grid = screen.getByRole('table', { name: 'When the agents worked' });
    const inked = () =>
      within(grid)
        .getAllByRole('button')
        .filter((b) => b.dataset.ink !== 'none');
    const all = inked().length;
    fireEvent.pointerEnter(row);
    expect(inked().length).toBeLessThan(all);
    expect(screen.getByText(`${name} only · ${time(cli.ms)}`)).toBeInTheDocument();
    fireEvent.pointerLeave(row);
    expect(inked()).toHaveLength(all);
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByText(`${name} only · ${time(cli.ms)} · Esc or click again to unpin`),
    ).toBeInTheDocument();
    fireEvent.keyDown(row, { key: 'Escape' });
    expect(row).toHaveAttribute('aria-pressed', 'false');
    expect(inked()).toHaveLength(all);
  });

  it('links a session only while the session list has it (R32)', async () => {
    serve({ week });
    const w = statsWeek(week, false);
    // An hour two sessions worked in.
    const found = w.receipt.grid
      .flatMap((cells, row) => cells.map((cell, col) => ({ row, col, hour: hourOfCell(w, cell) })))
      .find((c) => c.hour.sessions.length >= 2);
    const [one, two] = found?.hour.sessions ?? [];
    if (!found || !one || !two || found.hour.start == null) throw new Error('fixture');
    const listed = [{ id: one.id } as SessionSummary];
    render(page(createStore(), 'week', listed));
    await screen.findByText(/Data as of/);
    fireEvent.click(
      document.querySelector(`[data-cell="${found.row}:${found.col}"]`) as HTMLElement,
    );
    const card = screen.getByRole('region', { name: hourSpan(found.hour.start, 'week', 'en') });
    const link = within(card).getByRole('link', { name: one.title ?? 'Untitled session' });
    expect(link).toHaveAttribute('href', sessionLink(one.id));
    expect(within(card).queryByRole('link', { name: two.title ?? 'Untitled session' })).toBeNull();
    expect(within(card).getByText(two.title ?? 'Untitled session')).toBeInTheDocument();
  });

  it('shows the other window when switched, its hour the busiest again', async () => {
    const { calls } = serve({ week, d7 });
    const onWindow = vi.fn();
    const store = createStore();
    const { rerender } = render(page(store, 'week', [], onWindow));
    await screen.findByText(/Data as of/);
    // An hour picked in this week: the other window starts on its own busiest again.
    fireEvent.click(document.querySelector('[data-cell="0:0"]') as HTMLElement);
    expect(hourTitle()).toBe('Mon 00:00 – 01:00');
    fireEvent.click(screen.getByRole('radio', { name: 'Last 7 days' }));
    expect(onWindow).toHaveBeenCalledWith('7d');
    rerender(page(store, '7d', [], onWindow));
    const w7 = statsWeek(d7, false);
    const at = busiestCell(w7);
    const cell = at && w7.receipt.grid[at.row]?.[at.col];
    const hour = cell && hourOfCell(w7, cell);
    if (hour?.start == null) throw new Error('fixture');
    await waitFor(() => expect(hourTitle()).toBe(hourSpan(hour.start as number, '7d', 'en')));
    expect(calls).toEqual(['/api/week?window=week', '/api/week?window=7d']);
    // Back to this week, read before: shown at once, on its busiest hour, not the hour picked.
    fireEvent.click(document.querySelector('[data-cell="0:0"]') as HTMLElement);
    rerender(page(store, 'week', [], onWindow));
    const w = statsWeek(week, false);
    const b = busiestCell(w);
    const first = b && w.receipt.grid[b.row]?.[b.col];
    expect(hourTitle()).toBe(hourSpan(first ? (hourOfCell(w, first).start ?? 0) : 0, 'week', 'en'));
  });

  it('says the week could not be read, keeping what it had, with Refresh to try again', async () => {
    const { calls, next } = serve({ week });
    render(page(createStore()));
    await screen.findByText(/Data as of 20:41/);
    next('fail');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not read the week: HTTP 500 · Refresh',
    );
    expect(calls.at(-1)).toBe('/api/week?window=week&refresh=1');
    expect(overview()).toHaveTextContent(time(statsWeek(week, false).receipt.agentMs));
  });

  it('says how many sessions it could not read again this time', async () => {
    serve({ week: { ...week, stats: { ...week.stats, failed: 2 } } });
    render(page(createStore()));
    expect(await screen.findByRole('status')).toHaveTextContent(
      "Data as of 20:41 · 2 sessions couldn't be refreshed · Refresh",
    );
  });

  it('points an empty week to the last 7 days, when they have sessions', async () => {
    serve({ week: { ...week, sessions: [] }, d7 });
    const onWindow = vi.fn();
    render(page(createStore(), 'week', [], onWindow));
    expect(await screen.findByText('No sessions this week.')).toBeInTheDocument();
    const out = await screen.findByRole('button', {
      name: `Last 7 days has ${d7.sessions.length} sessions →`,
    });
    fireEvent.click(out);
    expect(onWindow).toHaveBeenCalledWith('7d');
  });

  it('prints from what it read: the dialog opens on its window with the slip, updating', async () => {
    const { next } = serve({ week, d7 });
    render(page(createStore(), '7d'));
    await screen.findByText(/Data as of/);
    next('hold');
    fireEvent.click(screen.getByRole('button', { name: 'Print weekly receipt' }));
    const dialog = await screen.findByRole('dialog', { name: 'Weekly receipt' });
    expect(within(dialog).getByRole('radio', { name: 'Last 7 days' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // No stub: the slip as it was read, its actions on, while the dialog reads it again.
    expect(within(dialog).getByRole('img')).toHaveAccessibleName(
      /^Weekly receipt, 1080 × \d+; its text follows$/,
    );
    expect(within(dialog).getByRole('button', { name: 'Copy image' })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(dialog).toHaveTextContent('Data as of 20:41 · Updating…');
  });
});

const agentNameOf = (kind: string) =>
  ({
    'claude-code': 'Claude Code',
    codex: 'Codex',
    grok: 'Grok',
    'oh-my-pi': 'oh-my-pi',
    opencode: 'OpenCode',
  })[kind] ?? kind;
