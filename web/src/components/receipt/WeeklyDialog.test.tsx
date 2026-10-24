import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WeekLine, WeekResult } from '../../../../src/shared/week.js';
import { I18nContext, makeI18n } from '../../i18n';
import { demoWeek, WEEK_NOW, weekResult } from '../../test/week';
import { WeeklyReceiptButton } from '../WeeklyReceiptButton';

/** A streamed /api/week answer: progress lines, then the result, unless held; `gap` between. */
function ndjson(lines: WeekLine[], hold = false, gap = ''): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(`${JSON.stringify(l)}\n${gap}`));
      if (!hold) c.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
}

const answer = (result: WeekResult, gap = '') =>
  ndjson(
    [
      { type: 'progress', done: 0, total: result.sessions.length },
      { type: 'progress', done: result.sessions.length, total: result.sessions.length },
      { type: 'result', result },
    ],
    false,
    gap,
  );

/** fetch answering /api/week from `results` by window; the calls and their signals it saw. */
function serve(
  results: { week?: WeekResult; d7?: WeekResult },
  opts: { hold?: boolean; gap?: string } = {},
) {
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (init?.signal) signals.push(init.signal);
      if (opts.hold) return ndjson([{ type: 'progress', done: 37, total: 112 }], true);
      const r = url.includes('window=7d') ? results.d7 : results.week;
      return r ? answer(r, opts.gap) : new Response('nope', { status: 500 });
    }),
  );
  return { calls, signals };
}

async function openWeekly(showProbes = false, locale: 'en' | 'zh' = 'en') {
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <WeeklyReceiptButton showProbes={showProbes} />
    </I18nContext.Provider>,
  );
  const name = locale === 'en' ? "This week's receipt" : '本周小票';
  fireEvent.click(screen.getByRole('button', { name }));
  return screen.findByRole('dialog', { name: locale === 'en' ? 'Weekly receipt' : '本周小票' });
}

const actions = (dialog: HTMLElement) =>
  ['Copy image', 'Download PNG', 'Copy as text'].map((name) =>
    within(dialog).getByRole('button', { name }),
  );

describe('the weekly receipt dialog', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(Date, 'now').mockReturnValue(WEEK_NOW);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prints a stub while the week is read, its actions off, its size not shown (W2, DR5)', async () => {
    serve({}, { hold: true });
    const dialog = await openWeekly();
    const img = within(dialog).getByRole('img');
    await waitFor(() =>
      expect(img).toHaveAccessibleName('Weekly receipt being read: 37 of 112 sessions'),
    );
    for (const b of actions(dialog)) expect(b).toHaveAttribute('aria-disabled', 'true');
    expect(within(dialog).getByText(/Reading every session of the week once/)).toBeInTheDocument();
    expect(within(dialog).getByRole('radiogroup', { name: 'Window' })).toBeInTheDocument();
    expect(within(dialog).queryByText(/^1080 × /)).toBeNull();
  });

  it('stops reading when it is closed', async () => {
    const { signals } = serve({}, { hold: true });
    const dialog = await openWeekly();
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('prints the week once read, titled as its slip, as of when, with Refresh (W2, DR6)', async () => {
    const r = demoWeek('week');
    // Blank lines in the stream are passed over (M6).
    const { calls } = serve({ week: r }, { gap: '\n' });
    const dialog = await openWeekly();
    const img = within(dialog).getByRole('img');
    await waitFor(() =>
      expect(img).toHaveAccessibleName(/^Weekly receipt, 1080 × \d{4}; its text follows$/),
    );
    expect(img).toHaveAccessibleDescription(/AGENT TIME/);
    expect(dialog).toHaveTextContent(
      `This week · Mon 16 Nov → Sat 21 Nov · 20:41 · ${r.sessions.length} sessions`,
    );
    for (const b of actions(dialog)) expect(b).not.toHaveAttribute('aria-disabled');
    expect(within(dialog).getByText(/Data as of 20:41/)).toBeInTheDocument();
    expect(calls).toEqual(['/api/week?window=week']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(calls).toContain('/api/week?window=week&refresh=1'));
  });

  it('ends its Chinese note with a Chinese full stop, running on without a space (C4)', async () => {
    serve({ week: demoWeek('week') });
    const dialog = await openWeekly(false, 'zh');
    await within(dialog).findByText(/数据截至 20:41/);
    expect(dialog).toHaveTextContent('数据截至 20:41 · 刷新。在你的浏览器里');
  });

  it('leaves probe sessions out unless the sidebar shows them (A1)', async () => {
    const r = demoWeek('week');
    const probed: WeekResult = {
      ...r,
      sessions: r.sessions.map((s, i) => (i === 0 ? { ...s, tags: ['probe'] } : s)),
    };
    serve({ week: probed });
    const dialog = await openWeekly();
    await waitFor(() => expect(dialog).toHaveTextContent(`· ${r.sessions.length - 1} sessions`));
  });

  it('counts probe sessions when the sidebar shows them', async () => {
    const r = demoWeek('week');
    serve({ week: { ...r, sessions: r.sessions.map((s) => ({ ...s, tags: ['probe'] })) } });
    const dialog = await openWeekly(true);
    await waitFor(() => expect(dialog).toHaveTextContent(`· ${r.sessions.length} sessions`));
  });

  it('switches to the last 7 days, reads them once, and remembers the choice', async () => {
    const { calls } = serve({ week: demoWeek('week'), d7: demoWeek('7d') });
    const dialog = await openWeekly();
    await within(dialog).findByText(/Data as of/);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Last 7 days' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('img')).toHaveAccessibleDescription(
        /Last 7 days · Sat 14 Nov 21:00/,
      ),
    );
    expect(dialog).toHaveTextContent('Last 7 days · Sat 14 Nov 21:00 → now');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'This week' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Last 7 days' }));
    expect(calls.filter((c) => c.includes('7d'))).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('glassbox.receipt') ?? '{}').window).toBe('7d');
  });

  it('has nothing to print for a week with no sessions, and says so (W5)', async () => {
    serve({ week: weekResult([], 'week'), d7: demoWeek('7d') });
    const dialog = await openWeekly();
    await waitFor(() =>
      expect(within(dialog).getByRole('img')).toHaveAccessibleDescription(
        /No sessions this week\./,
      ),
    );
    for (const b of actions(dialog)) {
      expect(b).toHaveAttribute('aria-disabled', 'true');
      expect(b).toHaveAttribute('title', 'Nothing to print yet');
    }
    // The way out: the last 7 days, read for the line that points to them.
    await waitFor(() =>
      expect(within(dialog).getByRole('img')).toHaveAccessibleDescription(
        /Last 7 days has \d+ sessions/,
      ),
    );
  });

  it('on a Monday morning, says how far into the week it is and what the last 7 days hold (W5)', async () => {
    const monday = new Date(2026, 10, 23, 0, 5).getTime();
    vi.spyOn(Date, 'now').mockReturnValue(monday);
    serve({ week: demoWeek('week', monday), d7: demoWeek('7d', monday) });
    const dialog = await openWeekly();
    expect(
      await within(dialog).findByText(/^5 minutes into the week · Last 7 days has \d+ sessions$/),
    ).toBeInTheDocument();
  });

  it('prints a failed stub when the week cannot be read, says so aloud, and offers to try again (C1)', async () => {
    const { calls } = serve({});
    const dialog = await openWeekly();
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Could not read the week: HTTP 500');
    const img = within(dialog).getByRole('img');
    expect(img).toHaveAccessibleName('Could not read the week: HTTP 500');
    await act(async () => {});
    for (const b of actions(dialog)) expect(b).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(calls).toEqual(['/api/week?window=week', '/api/week?window=week']));
  });
});
