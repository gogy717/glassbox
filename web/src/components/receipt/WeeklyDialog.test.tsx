import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WeekLine, WeekResult } from '../../../../src/shared/week.js';
import { I18nContext, makeI18n } from '../../i18n';
import { demoOpen } from '../../test/demo';
import { demoWeek, WEEK_NOW, weekResult } from '../../test/week';
import { SummaryBar } from '../SummaryBar';
import { WeeklyReceiptButton } from '../WeeklyReceiptButton';
import { receiptData } from './data';

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

/**
 * fetch answering /api/week from `results` by window; the calls and their signals it saw. `hold`
 * keeps every request reading, `refresh` only the refreshes, or fails them.
 */
function serve(
  results: { week?: WeekResult; d7?: WeekResult },
  opts: { hold?: boolean; gap?: string; refresh?: 'hold' | 'fail' } = {},
) {
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (init?.signal) signals.push(init.signal);
      const refresh = url.includes('refresh=1');
      if (refresh && opts.refresh === 'fail') return new Response('nope', { status: 500 });
      if (opts.hold || (refresh && opts.refresh === 'hold'))
        return ndjson([{ type: 'progress', done: 37, total: 112 }], true);
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
  // The Stats page's button (D4), on its default window; the dialog keeps its own title.
  fireEvent.click(
    screen.getByRole('button', { name: locale === 'en' ? 'Print weekly receipt' : '打印本周小票' }),
  );
  return screen.findByRole('dialog', { name: locale === 'en' ? 'Weekly receipt' : '本周小票' });
}

/** The session's receipt, opened from its Summary bar's button. */
async function openSession() {
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <SummaryBar open={demoOpen()} agentId="main" rate={null} />
    </I18nContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Receipt' }));
  return screen.findByRole('dialog', { name: 'Receipt' });
}

/** The Scope switch's values, and which one is on. */
const scopes = (dialog: HTMLElement) =>
  within(within(dialog).getByRole('radiogroup', { name: 'Scope' }))
    .getAllByRole('radio')
    .map((r) => `${r.textContent}${r.getAttribute('aria-checked') === 'true' ? ' ✓' : ''}`);

const choose = (dialog: HTMLElement, name: string) =>
  fireEvent.click(within(dialog).getByRole('radio', { name }));

/** Downloads made by the dialog, its canvas and anchors stubbed (jsdom draws nothing). */
function catchDownloads(): HTMLAnchorElement[] {
  const clicked: HTMLAnchorElement[] = [];
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    value: async () => {},
    configurable: true,
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ drawImage: vi.fn() }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) =>
    cb(new Blob(['png'], { type: 'image/png' })),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  URL.createObjectURL = vi.fn(() => 'blob:receipt');
  URL.revokeObjectURL = vi.fn();
  return clicked;
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
    expect(scopes(dialog)).toEqual(['This week ✓', 'Last 7 days']);
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

  it('switches to the last 7 days and back, reading each once, and starts on This week again (G10b)', async () => {
    const { calls } = serve({ week: demoWeek('week'), d7: demoWeek('7d') });
    let dialog = await openWeekly();
    await within(dialog).findByText(/Data as of/);
    choose(dialog, 'Last 7 days');
    await waitFor(() =>
      expect(within(dialog).getByRole('img')).toHaveAccessibleDescription(
        /Last 7 days · Sat 14 Nov 21:00/,
      ),
    );
    expect(dialog).toHaveTextContent('Last 7 days · Sat 14 Nov 21:00 → now');
    choose(dialog, 'This week');
    choose(dialog, 'Last 7 days');
    expect(calls.filter((c) => c.includes('7d'))).toHaveLength(1);
    choose(dialog, 'Night');
    // The scope is not remembered, the other choices are: Home's button starts on This week.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Print weekly receipt' }));
    dialog = await screen.findByRole('dialog', { name: 'Weekly receipt' });
    expect(scopes(dialog)).toEqual(['This week ✓', 'Last 7 days']);
    const saved = JSON.parse(localStorage.getItem('glassbox.receipt') ?? '{}');
    expect(Object.keys(saved).sort()).toEqual(['hideNames', 'locale', 'paper', 'size']);
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

describe('the receipt dialog’s scope (G10b)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(Date, 'now').mockReturnValue(WEEK_NOW);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts from Home on This week, offering only the two weeks', async () => {
    serve({ week: demoWeek('week') });
    expect(scopes(await openWeekly())).toEqual(['This week ✓', 'Last 7 days']);
  });

  it('starts from a session on This session, reading no week until one is chosen', async () => {
    const { calls } = serve({ week: demoWeek('week') });
    const dialog = await openSession();
    expect(scopes(dialog)).toEqual(['This session ✓', 'This week', 'Last 7 days']);
    await act(async () => {});
    expect(calls).toEqual([]);
    expect(dialog).toHaveTextContent('Made in your browser from the data on this page.');
    expect(within(dialog).queryByRole('button', { name: 'Refresh' })).toBeNull();
  });

  it('swaps the slip in place, both ways: title, subtitle, slip, note', async () => {
    const r = demoWeek('week');
    const { calls } = serve({ week: r });
    const dialog = await openSession();
    const { project, title } = receiptData(demoOpen(), WEEK_NOW);
    const subtitle = [project, title].filter(Boolean).join(' / ');
    expect(within(dialog).getByText(subtitle)).toBeInTheDocument();
    choose(dialog, 'This week');
    expect(screen.getByRole('dialog', { name: 'Weekly receipt' })).toBe(dialog);
    await waitFor(() =>
      expect(within(dialog).getByRole('img')).toHaveAccessibleName(
        /^Weekly receipt, 1080 × \d{4}; its text follows$/,
      ),
    );
    expect(dialog).toHaveTextContent(
      `This week · Mon 16 Nov → Sat 21 Nov · 20:41 · ${r.sessions.length} sessions`,
    );
    expect(within(dialog).getByText(/Data as of 20:41/)).toBeInTheDocument();
    expect(within(dialog).queryByText(subtitle)).toBeNull();
    expect(dialog).toHaveTextContent('Made in your browser; nothing leaves this machine.');
    expect(dialog).toHaveTextContent('Withholds titles and project names');
    choose(dialog, 'This session');
    expect(screen.getByRole('dialog', { name: 'Receipt' })).toBe(dialog);
    expect(within(dialog).getByText(subtitle)).toBeInTheDocument();
    expect(within(dialog).getByRole('img')).toHaveAccessibleName(
      /^Receipt, 1080 × \d{4}; its text follows$/,
    );
    expect(within(dialog).queryByText(/Data as of/)).toBeNull();
    expect(dialog).toHaveTextContent('Withholds the title and the project');
    // The week again: as read, not read again.
    choose(dialog, 'This week');
    expect(within(dialog).getByRole('img')).toHaveAccessibleName(/^Weekly receipt, 1080/);
    expect(calls).toEqual(['/api/week?window=week']);
  });

  it('prints the stub, with progress, for a week still being read; the session as soon as it is back', async () => {
    serve({}, { hold: true });
    const dialog = await openSession();
    choose(dialog, 'Last 7 days');
    await waitFor(() =>
      expect(within(dialog).getByRole('img')).toHaveAccessibleName(
        'Weekly receipt being read: 37 of 112 sessions',
      ),
    );
    for (const b of actions(dialog)) expect(b).toHaveAttribute('aria-disabled', 'true');
    choose(dialog, 'This session');
    for (const b of actions(dialog)) expect(b).not.toHaveAttribute('aria-disabled');
  });

  it('carries size, paper, language and hidden names across, and names the file by the scope', async () => {
    serve({ week: demoWeek('week') });
    const clicked = catchDownloads();
    const dialog = await openSession();
    for (const name of ['Post 4:5', 'Night', '中文', 'On']) choose(dialog, name);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download PNG' }));
    await within(dialog).findByText('Downloaded');
    expect(clicked[0]?.download).toMatch(/^glassbox-receipt-\d{8}-\d{4}\.png$/);
    choose(dialog, 'This week');
    const img = within(dialog).getByRole('img');
    await waitFor(() =>
      expect(img).toHaveAccessibleName('Weekly receipt, 1080 × 1350; its text follows'),
    );
    for (const name of ['Post 4:5', 'Night', '中文', 'On'])
      expect(within(dialog).getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
    // Drawn with them: in Chinese, the longest session not named.
    expect(img).toHaveAccessibleDescription(/本周小票/);
    expect(img).toHaveAccessibleDescription(/一个会话/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download PNG' }));
    await waitFor(() => expect(clicked).toHaveLength(2));
    expect(clicked[1]?.download).toBe('glassbox-week-2026-W47.png');
  });

  it('keeps a refresh, and its failure, to the window it was asked for (G8)', async () => {
    serve({ week: demoWeek('week'), d7: demoWeek('7d') }, { refresh: 'hold' });
    const dialog = await openWeekly();
    await within(dialog).findByText(/Data as of 20:41/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh' }));
    await within(dialog).findByText(/Reading 37 of 112 sessions/);
    choose(dialog, 'Last 7 days');
    await within(dialog).findByText(/Data as of 20:41/);
    expect(within(dialog).queryByText(/Reading 37 of 112/)).toBeNull();
    choose(dialog, 'This week');
    expect(within(dialog).getByText(/Reading 37 of 112 sessions/)).toBeInTheDocument();
    cleanup();

    serve({ week: demoWeek('week'), d7: demoWeek('7d') }, { refresh: 'fail' });
    const again = await openWeekly();
    await within(again).findByText(/Data as of 20:41/);
    fireEvent.click(within(again).getByRole('button', { name: 'Refresh' }));
    await within(again).findByText(/Could not read the week: HTTP 500/);
    choose(again, 'Last 7 days');
    await within(again).findByText(/Data as of 20:41/);
    expect(within(again).queryByText(/Could not read the week/)).toBeNull();
  });

  it('says when its data is from, in its title and its note, when that is not when it was asked', async () => {
    const r = demoWeek('week');
    serve({ week: { ...r, asOf: WEEK_NOW - 2 * 60_000 } });
    const dialog = await openWeekly();
    await within(dialog).findByText(/Data as of 20:39/);
    expect(dialog).toHaveTextContent(
      `This week · Mon 16 Nov → Sat 21 Nov · 20:39 · ${r.sessions.length} sessions`,
    );
  });

  it('counts in the way out only the sessions the sidebar lists (A1)', async () => {
    const monday = new Date(2026, 10, 23, 0, 5).getTime();
    vi.spyOn(Date, 'now').mockReturnValue(monday);
    const d7 = demoWeek('7d', monday);
    const probed = {
      ...d7,
      sessions: d7.sessions.map((s, i) => (i < 3 ? { ...s, tags: ['probe'] } : s)),
    };
    for (const [shown, n] of [
      [false, d7.sessions.length - 3],
      [true, d7.sessions.length],
    ] as const) {
      serve({ week: demoWeek('week', monday), d7: probed });
      const dialog = await openWeekly(shown);
      expect(
        await within(dialog).findByText(`5 minutes into the week · Last 7 days has ${n} sessions`),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(within(dialog).getByRole('img')).toHaveAccessibleDescription(
          new RegExp(`Last 7 days has ${n} sessions and`),
        ),
      );
      cleanup();
    }
  });
});
