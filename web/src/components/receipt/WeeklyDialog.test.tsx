import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WeekLine, WeekResult } from '../../../../src/shared/week.js';
import { I18nContext, makeI18n } from '../../i18n';
import { demoWeek, WEEK_NOW, weekResult } from '../../test/week';
import { WeeklyReceiptButton } from '../WeeklyReceiptButton';

/** A streamed /api/week answer: progress lines, then the result, unless held. */
function ndjson(lines: WeekLine[], hold = false): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(`${JSON.stringify(l)}\n`));
      if (!hold) c.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
}

const answer = (result: WeekResult) =>
  ndjson([
    { type: 'progress', done: 0, total: result.sessions.length },
    { type: 'progress', done: result.sessions.length, total: result.sessions.length },
    { type: 'result', result },
  ]);

/** fetch answering /api/week from `results` by window; the calls it saw. */
function serve(results: { week?: WeekResult; d7?: WeekResult }, hold = false) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (hold) return ndjson([{ type: 'progress', done: 37, total: 112 }], true);
      const r = url.includes('window=7d') ? results.d7 : results.week;
      return r ? answer(r) : new Response('nope', { status: 500 });
    }),
  );
  return calls;
}

async function openWeekly() {
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <WeeklyReceiptButton />
    </I18nContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: "This week's receipt" }));
  return screen.findByRole('dialog', { name: 'Weekly receipt' });
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

  it('prints a stub while the week is read, its actions off (W2)', async () => {
    serve({}, true);
    const dialog = await openWeekly();
    const img = within(dialog).getByRole('img');
    await waitFor(() =>
      expect(img).toHaveAccessibleName('Weekly receipt being read: 37 of 112 sessions'),
    );
    for (const b of actions(dialog)) expect(b).toHaveAttribute('aria-disabled', 'true');
    expect(within(dialog).getByText(/Reading every session of the week once/)).toBeInTheDocument();
    expect(within(dialog).getByRole('radiogroup', { name: 'Window' })).toBeInTheDocument();
  });

  it('prints the week once read, and says as of when, with Refresh (W2)', async () => {
    const calls = serve({ week: demoWeek('week') });
    const dialog = await openWeekly();
    const img = within(dialog).getByRole('img');
    await waitFor(() =>
      expect(img).toHaveAccessibleName(/^Weekly receipt, 1080 × \d{4}; its text follows$/),
    );
    expect(img).toHaveAccessibleDescription(/AGENT TIME/);
    for (const b of actions(dialog)) expect(b).not.toHaveAttribute('aria-disabled');
    expect(within(dialog).getByText(/Data as of 20:41/)).toBeInTheDocument();
    expect(calls).toEqual(['/api/week?window=week']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(calls).toContain('/api/week?window=week&refresh=1'));
  });

  it('switches to the last 7 days, reads them once, and remembers the choice', async () => {
    const calls = serve({ week: demoWeek('week'), d7: demoWeek('7d') });
    const dialog = await openWeekly();
    await within(dialog).findByText(/Data as of/);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Last 7 days' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('img')).toHaveAccessibleDescription(
        /Last 7 days · Sat 17 Oct 21:00/,
      ),
    );
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
    const monday = new Date(2026, 9, 26, 0, 5).getTime();
    vi.spyOn(Date, 'now').mockReturnValue(monday);
    serve({ week: demoWeek('week', monday), d7: demoWeek('7d', monday) });
    const dialog = await openWeekly();
    expect(
      await within(dialog).findByText(/^5 minutes into the week · Last 7 days has \d+ sessions$/),
    ).toBeInTheDocument();
  });

  it('says a week that cannot be read could not be read, and offers to try again', async () => {
    serve({});
    const dialog = await openWeekly();
    expect(
      await within(dialog).findByText(/Could not read the week: HTTP 500/),
    ).toBeInTheDocument();
    await act(async () => {});
    for (const b of actions(dialog)) expect(b).toHaveAttribute('aria-disabled', 'true');
  });
});
