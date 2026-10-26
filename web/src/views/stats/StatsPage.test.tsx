import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../../../../src/core/model.js';
import type { WeekLine, WeekResult, WeekWindowKind } from '../../../../src/shared/week.js';
import { durationParts, hourOf, partsText } from '../../components/receipt/format';
import { createStore, type Store, StoreContext } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import { sessionLink } from '../../router';
import { demoWeek, WEEK_NOW } from '../../test/week';
import { StatsPage } from './StatsPage';
import { busiestCell, hourOfCell, hourSpan, isolated, statsWeek } from './statsData';

// Each cell drawn asks its ink: counting the asks counts the cells drawn.
const draws = vi.hoisted(() => ({ cells: 0 }));
vi.mock('../../components/receipt/weekFigures', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../components/receipt/weekFigures')>();
  return {
    ...real,
    inkOf: (cell: Parameters<typeof real.inkOf>[0]) => {
      draws.cells++;
      return real.inkOf(cell);
    },
  };
});

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
  showProbes = false,
) {
  return (
    <StoreContext.Provider value={store}>
      <I18nContext.Provider value={makeI18n('en')}>
        <StatsPage
          window={kind}
          onWindow={onWindow}
          showProbes={showProbes}
          sessions={sessions}
          quotas={[]}
          now={WEEK_NOW}
        />
      </I18nContext.Provider>
    </StoreContext.Provider>
  );
}

const overview = () => screen.getByRole('region', { name: 'Summary' });
const asOf = () => screen.getByText(/^Data as of/);
const fetchCalls = () => (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
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
    expect(asOf()).toHaveTextContent('Data as of 20:41 · Updating…');
  });

  it('says how far a first read got, over empty cards', async () => {
    const { next } = serve({ week });
    next('hold');
    render(page(createStore()));
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull();
    // Before the server says how many there are, only that it is reading them (DR5).
    expect(screen.getByRole('status')).toHaveTextContent(/^Reading sessions…$/);
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
    // The time its row prints, the receipt's share of the minutes (DR10): the caption's too (M1).
    const rowTime = row.querySelector('.figure')?.textContent ?? '';
    fireEvent.pointerEnter(row);
    expect(inked().length).toBeLessThan(all);
    expect(screen.getByText(`${name} only · ${rowTime}`)).toBeInTheDocument();
    fireEvent.pointerLeave(row);
    expect(inked()).toHaveLength(all);
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByText(`${name} only · ${rowTime} · Esc or click again to unpin`),
    ).toBeInTheDocument();
    // The overview stays the window's own, whatever is isolated.
    expect(overview()).toHaveTextContent(time(w.receipt.agentMs));
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
    // The alert says the failure alone; Refresh sits beside it.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/^Could not read the week: HTTP 500$/);
    expect(alert.parentElement).toHaveTextContent('Could not read the week: HTTP 500 · Refresh');
    expect(calls.at(-1)).toBe('/api/week?window=week&refresh=1');
    expect(overview()).toHaveTextContent(time(statsWeek(week, false).receipt.agentMs));
  });

  it('says how many sessions it could not read again this time', async () => {
    serve({ week: { ...week, stats: { ...week.stats, failed: 2 } } });
    render(page(createStore()));
    await screen.findByText(/Data as of 20:41/);
    expect(asOf()).toHaveTextContent(
      "Data as of 20:41 · 2 sessions couldn't be refreshed · Refresh",
    );
  });

  it('keeps the minute’s re-read quiet to a screen reader, and a failure said once (M4)', async () => {
    const { next } = serve({ week });
    render(page(createStore()));
    await screen.findByText(/Data as of 20:41/);
    // When the data is from is shown, not announced: no live region holds it.
    expect(asOf().closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    next('fail');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const alert = await screen.findByRole('alert');
    // Read again, and failing again: the same alert, not taken away and said anew.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(fetchCalls()).toBe(3));
    await act(async () => {});
    expect(screen.getByRole('alert')).toBe(alert);
  });

  it('says it is updating while a failed read is tried again, the failure not said anew', async () => {
    const { next } = serve({ week });
    render(page(createStore()));
    await screen.findByText(/Data as of 20:41/);
    next('fail');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const alert = await screen.findByRole('alert');
    next('hold');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      // Updating… where Refresh was, so a second click has nothing to queue behind the read.
      expect(alert.parentElement).toHaveTextContent(
        'Could not read the week: HTTP 500 · Updating…',
      );
      expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
      // The alert itself unchanged: a read starting is not announced as the failure again (M4).
      expect(screen.getByRole('alert')).toBe(alert);
      expect(alert).toHaveTextContent(/^Could not read the week: HTTP 500$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says only that it is reading when a failed first read is tried again, as the dialog does', async () => {
    const { next } = serve({ week });
    next('fail');
    render(page(createStore()));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the week: HTTP 500');
    next('hold');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Reading sessions…'));
    // Not run together with the failure it is trying again.
    expect(screen.queryByText(/Could not read the week/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
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

  it('prints in the caption the time its CLI’s row prints, its share of the minutes (M1)', async () => {
    // Two CLIs of 10m 40s each: the 21 minutes of the hero share out 11 and 10.
    const of = (agent: string) => week.sessions.find((s) => s.agent === agent);
    const tenForty = (s: WeekResult['sessions'][number] | undefined) => {
      if (!s) throw new Error('fixture');
      return {
        ...s,
        hours: s.hours.map((_, i) => (i === 30 ? 640_000 : 0)),
        inWindow: { ...s.inWindow, agentMs: 640_000 },
      };
    };
    const two = { ...week, sessions: [tenForty(of('claude-code')), tenForty(of('codex'))] };
    serve({ week: two });
    render(page(createStore()));
    const first = statsWeek(two, false).receipt.byCli[0];
    if (!first) throw new Error('fixture');
    const name = agentNameOf(first.agent);
    const row = await screen.findByRole('button', { name: new RegExp(`^${name}`) });
    expect(row.querySelector('.figure')?.textContent).toBe('11m');
    fireEvent.click(row);
    expect(
      screen.getByText(`${name} only · 11m · Esc or click again to unpin`),
    ).toBeInTheDocument();
  });

  it('draws only the tip as the pointer moves over the hours, no cell again (I1)', async () => {
    serve({ week });
    render(page(createStore()));
    await screen.findByText(/Data as of 20:41/);
    const cells = [...document.querySelectorAll<HTMLElement>('[data-cell]')];
    const drawn = draws.cells;
    for (const cell of cells.slice(0, 40)) fireEvent.pointerOver(cell);
    expect(draws.cells).toBe(drawn);
    // The last hour hovered, in its tip: its label's first part, in bold.
    const last = cells[39]?.getAttribute('aria-label')?.split(' · ')[0] ?? '';
    expect(screen.getByText(last, { selector: 'strong' })).toBeInTheDocument();
  });

  it('counts probe sessions only when the sidebar shows them, as the receipt does', async () => {
    const probed = {
      ...week,
      sessions: week.sessions.map((s, i) => (i ? s : { ...s, tags: ['probe'] })),
    };
    serve({ week: probed });
    // The overview's Sessions figure: "52 · 6 projects".
    const sessions = (k: number) => new RegExp(`(^|\\D)${k} · \\d+ projects?`);
    const { unmount } = render(page(createStore()));
    await waitFor(() => expect(overview()).toHaveTextContent(sessions(week.sessions.length - 1)));
    unmount();
    render(page(createStore(), 'week', [], vi.fn(), true));
    await waitFor(() => expect(overview()).toHaveTextContent(sessions(week.sessions.length)));
  });

  it('says it is updating only when a re-read takes a moment: a quick one never flashes (N7)', async () => {
    const { next } = serve({ week });
    const store = createStore();
    const first = render(page(store));
    await screen.findByText(/Data as of 20:41/);
    first.unmount();
    next('hold');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      render(page(store));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(asOf()).toHaveTextContent('Data as of 20:41 · Refresh');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(asOf()).toHaveTextContent('Data as of 20:41 · Updating…');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a pinned CLI fill the hour card and the busiest hour; a hover previews the grid only (DR3)', async () => {
    serve({ week });
    const w = statsWeek(week, false);
    render(page(createStore()));
    const cli = w.receipt.byCli[1];
    const other = w.receipt.byCli[0];
    if (!cli || !other) throw new Error('fixture');
    const row = await screen.findByRole('button', {
      name: new RegExp(`^${agentNameOf(cli.agent)}`),
    });
    fireEvent.click(row);
    const mine = isolated(w, { cli: cli.agent });
    const at = busiestCell(mine);
    const cell = at && mine.receipt.grid[at.row]?.[at.col];
    const hour = cell && hourOfCell(mine, cell);
    if (!hour || hour.start === null || !mine.receipt.busiest) throw new Error('fixture');
    const title = hourSpan(hour.start, 'week', 'en');
    expect(hourTitle()).toBe(title);
    const card = screen.getByRole('region', { name: title });
    // Its own sessions only: every row's tag is the pinned CLI's.
    const tags = within(card).getAllByText(/^(Claude Code|Codex|Grok|oh-my-pi|OpenCode)$/);
    expect(tags.map((t) => t.textContent)).toEqual(hour.sessions.map(() => agentNameOf(cli.agent)));
    expect(screen.getByText(/^Busiest hour/)).toHaveTextContent(
      hourOf(mine.receipt.busiest.at, 'en'),
    );
    // A hover over another CLI redraws the grid, and leaves the card as it was.
    fireEvent.pointerEnter(
      screen.getByRole('button', { name: new RegExp(`^${agentNameOf(other.agent)}`) }),
    );
    expect(hourTitle()).toBe(title);
  });

  it('keeps a cell’s tip true to the grid under it when Escape lets a pin go', async () => {
    serve({ week });
    const w = statsWeek(week, false);
    render(page(createStore()));
    const cli = w.receipt.byCli[1];
    if (!cli) throw new Error('fixture');
    const row = await screen.findByRole('button', {
      name: new RegExp(`^${agentNameOf(cli.agent)}`),
    });
    // An hour others worked in, this CLI not.
    const mine = isolated(w, { cli: cli.agent });
    const at = w.receipt.grid
      .flatMap((cells, r) => cells.map((c, col) => ({ r, col, ms: c.ms })))
      .find(({ r, col, ms }) => ms > 0 && (mine.receipt.grid[r]?.[col]?.ms ?? 0) === 0);
    const cell = at && document.querySelector<HTMLElement>(`[data-cell="${at.r}:${at.col}"]`);
    if (!cell) throw new Error('fixture');
    fireEvent.click(row);
    fireEvent.click(cell);
    act(() => cell.focus());
    const title = cell.getAttribute('aria-label')?.split(' · ')[0] ?? '';
    const tip = () => screen.getByText(title, { selector: 'strong' }).parentElement;
    expect(tip()).toHaveTextContent(`${title}No agent worked`);
    fireEvent.keyDown(cell, { key: 'Escape' });
    expect(row).toHaveAttribute('aria-pressed', 'false');
    // The whole window drawn again: the tip says what the cell now says.
    const label = cell.getAttribute('aria-label') ?? '';
    expect(label).not.toContain('No agent worked');
    expect(tip()).toHaveTextContent(label.replace(' · ', ''));
  });

  it('keeps all three cards on an empty week, each with a dash and no hint (DR4)', async () => {
    serve({ week: { ...week, sessions: [] }, d7 });
    render(page(createStore()));
    await screen.findByText('No sessions this week.');
    for (const name of [/^By CLI/, /^Top projects/, /^Longest sessions/])
      expect(within(screen.getByRole('region', { name })).getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/Hover to isolate in the grid/)).toBeNull();
  });

  it('puts the tab stop back on the selected hour when the week is read again (M6)', async () => {
    serve({ week });
    render(page(createStore()));
    await screen.findByText(/Data as of 20:41/);
    const grid = screen.getByRole('table', { name: 'When the agents worked' });
    const selected = within(grid).getByRole('button', { current: true });
    act(() => selected.focus());
    fireEvent.keyDown(selected, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(selected).toHaveAttribute('tabindex', '-1');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(within(grid).getByRole('button', { current: true })).toHaveAttribute('tabindex', '0'),
    );
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it('steps over an hour the window does not have, as on a day that changes the clocks (M6)', async () => {
    // Monday 05:00 left out of the window: its cell is not drawn, and the keys pass it by.
    const gap: WeekResult = {
      ...week,
      window: { ...week.window, hourStarts: week.window.hourStarts.filter((_, i) => i !== 5) },
      sessions: week.sessions.map((s) => ({ ...s, hours: s.hours.filter((_, i) => i !== 5) })),
    };
    serve({ week: gap });
    render(page(createStore()));
    await screen.findByText(/Data as of/);
    const four = document.querySelector('[data-cell="0:4"]') as HTMLElement;
    expect(document.querySelector('[data-cell="0:5"]')).toHaveAttribute('data-ink', 'out');
    fireEvent.click(four);
    act(() => four.focus());
    fireEvent.keyDown(four, { key: 'ArrowRight' });
    expect(document.activeElement).toHaveAttribute('data-cell', '0:6');
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

// Branch D (F7) item 6: the note under the switch, for the visit that opened on the last 7 days.
describe('the Stats page’s note on its default window', () => {
  const noted = (store: Store, kind: WeekWindowKind, note: boolean, onNoteSeen = vi.fn()) => (
    <StoreContext.Provider value={store}>
      <I18nContext.Provider value={makeI18n('en')}>
        <StatsPage
          window={kind}
          onWindow={vi.fn()}
          showProbes={false}
          sessions={[]}
          quotas={[]}
          now={WEEK_NOW}
          note={note}
          onNoteSeen={onNoteSeen}
        />
      </I18nContext.Provider>
    </StoreContext.Provider>
  );
  const text = /Less than a day into the week, Stats opens on the last 7 days/;

  it('says why the window is the last 7 days, once told, and goes with This week', async () => {
    serve({ week, d7 });
    const store = createStore();
    const onNoteSeen = vi.fn();
    const { rerender } = render(noted(store, '7d', true, onNoteSeen));
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(onNoteSeen).toHaveBeenCalledTimes(1);
    // Remembered by the caller, the prop drops; the note stays for this visit, said no second time.
    rerender(noted(store, '7d', false, onNoteSeen));
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(onNoteSeen).toHaveBeenCalledTimes(1);
    rerender(noted(store, 'week', false, onNoteSeen));
    expect(screen.queryByText(text)).toBeNull();
    await screen.findByText(/Data as of/);
  });

  it('is not said when the page opened without it', async () => {
    serve({ week, d7 });
    const onNoteSeen = vi.fn();
    render(noted(createStore(), '7d', false, onNoteSeen));
    expect(screen.queryByText(text)).toBeNull();
    expect(onNoteSeen).not.toHaveBeenCalled();
    await screen.findByText(/Data as of/);
  });
});
