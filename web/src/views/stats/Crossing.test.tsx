import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoSnapshot, DEMO_SESSION_ID } from '../../../../src/core/fixtures/demo.js';
import type { SessionSnapshot } from '../../../../src/core/model.js';
import { createDemoWeek } from '../../../../src/server/week-demo.js';
import type { WeekResult } from '../../../../src/shared/week.js';
import { I18nContext, makeI18n } from '../../i18n';
import { callLink } from '../../router';
import { demoWeek, WEEK_NOW } from '../../test/week';
import { CrossingCard } from './Crossing';
import { statsWeek } from './statsData';

function renderCard(result: WeekResult = demoWeek(), locale: 'en' | 'zh' = 'en') {
  return render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <CrossingCard w={statsWeek(result, false)} locale={locale} />
    </I18nContext.Provider>,
  );
}

/** The demo's sessions, as `/api/sessions/:id` answers; the URLs asked. */
function serveSessions() {
  const snaps = new Map<string, SessionSnapshot>(
    [createDemoSnapshot(new Date(WEEK_NOW)), ...createDemoWeek(WEEK_NOW)].map((s) => [
      s.session.id,
      s,
    ]),
  );
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url);
      const id = decodeURIComponent(url.replace(/^\/api\/sessions\//, ''));
      const snap = snaps.get(id);
      return snap
        ? new Response(JSON.stringify(snap))
        : new Response(JSON.stringify({ error: 'session not found' }), { status: 404 });
    }),
  );
  return { snaps, asked };
}

/** The demo week with its worktree's sessions changing no file. */
const withoutWorktreeFiles = (r: WeekResult): WeekResult => ({
  ...r,
  sessions: r.sessions.map((s) =>
    s.repo?.dir.includes('/worktrees/')
      ? { ...s, inWindow: { ...s.inWindow, files: undefined } }
      : s,
  ),
});

describe('the Crossing card', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('says how many files more than one worktree of a repository changed, and how many on the same lines', () => {
    renderCard();
    const card = screen.getByRole('region', { name: /Crossing/ });
    expect(card).toHaveTextContent(
      '3 files changed from more than one worktree of glassbox · 1 on the same lines',
    );
    expect(within(card).getByRole('button', { name: 'Show files' })).toBeInTheDocument();
  });

  it('is not drawn when no repository had sessions in two worktrees', () => {
    const r = demoWeek();
    const { container } = renderCard({
      ...r,
      sessions: r.sessions.filter((s) => !s.repo?.dir.includes('/worktrees/')),
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('says so when two worktrees changed no file in common, with nothing to show', () => {
    renderCard(withoutWorktreeFiles(demoWeek()));
    const card = screen.getByRole('region', { name: /Crossing/ });
    expect(card).toHaveTextContent('No file changed from more than one worktree of glassbox');
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('opens a panel of the files, a column per worktree, the same lines in the error tone', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Show files' }));
    const dialog = screen.getByRole('dialog', { name: 'Crossing' });
    const table = within(dialog).getByRole('table', { name: 'glassbox' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['File', 'glassbox · main', 'glassbox-sidebar']);
    const rows = within(table).getAllByRole('rowheader');
    expect(rows.map((r) => r.textContent)).toEqual([
      'src/server/store.tsSame lines',
      'src/app.tsLines not known',
      'src/server/sessions.tsDifferent lines',
    ]);
    const store = rows[0]?.closest('tr') as HTMLElement;
    const [main, tree] = within(store).getAllByRole('cell');
    expect(main).toHaveTextContent(/2 edits · 1 session · last .+ · lines 36, 41/);
    expect(tree).toHaveTextContent(/1 edit · 1 session · last .+ · line 41/);
    // The run both trees changed, in the error tone; the main tree's other run apart from it.
    expect([...store.querySelectorAll('[data-hot]')].map((s) => s.textContent)).toEqual([
      '41',
      '41',
    ]);
    const app = rows[1]?.closest('tr') as HTMLElement;
    expect(within(app).getAllByRole('cell')[0]).toHaveTextContent(/lines not known/);
    // A narrow column breaks a path after a slash, never inside a name.
    expect(rows[0]?.querySelectorAll('wbr')).toHaveLength(2);
  });

  it('unfolds a file into each worktree’s changes side by side, each a link to its call', async () => {
    const { snaps } = serveSessions();
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Show files' }));
    const dialog = screen.getByRole('dialog', { name: 'Crossing' });
    const file = within(dialog).getByRole('button', { name: /src\/server\/store\.ts/ });
    fireEvent.click(file);
    expect(file).toHaveAttribute('aria-expanded', 'true');
    const sides = await within(dialog).findAllByRole('region', { name: /^Changes in / });
    expect(sides.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Changes in glassbox',
      'Changes in glassbox-sidebar',
    ]);
    // The main tree: the open session's two edits that landed (the failed one is no change).
    const mainLinks = await within(sides[0] as HTMLElement).findAllByRole('link');
    const demo = snaps.get(DEMO_SESSION_ID) as SessionSnapshot;
    const tool = (id: string) =>
      demo.toolCalls.find((t) => t.id === id) as (typeof demo.toolCalls)[number];
    expect(mainLinks.map((a) => a.getAttribute('href'))).toEqual([
      callLink(DEMO_SESSION_ID, tool('tu_m2d'), 'turn_m1'),
      callLink(DEMO_SESSION_ID, tool('tu_m2e'), 'turn_m1'),
    ]);
    expect(mainLinks[0]).toHaveTextContent(/^Edit:41-43·edited·/);
    // The worktree's one edit, its diff beside the main tree's.
    const treeLinks = await within(sides[1] as HTMLElement).findAllByRole('link');
    expect(treeLinks).toHaveLength(1);
    expect(treeLinks[0]).toHaveTextContent(/^Edit:41·edited·/);
    expect(within(sides[1] as HTMLElement).getByRole('list', { name: 'Change' })).toHaveTextContent(
      'return sessions.sort(byRecent);',
    );
  });

  it('says when a session cannot be read, the other side still shown', async () => {
    const { snaps } = serveSessions();
    snaps.delete(DEMO_SESSION_ID);
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Show files' }));
    fireEvent.click(screen.getByRole('button', { name: /src\/server\/store\.ts/ }));
    const sides = await screen.findAllByRole('region', { name: /^Changes in / });
    await waitFor(() => expect(sides[0]).toHaveTextContent('This session could not be read'));
    expect(await within(sides[1] as HTMLElement).findAllByRole('link')).toHaveLength(1);
  });

  it('speaks Chinese', () => {
    renderCard(demoWeek(), 'zh');
    const card = screen.getByRole('region', { name: /交叉改动/ });
    expect(card).toHaveTextContent(
      'glassbox 有 3 个文件在不止一个工作树里改过 · 其中 1 个改到同一处',
    );
    expect(within(card).getByRole('button', { name: '查看文件' })).toBeInTheDocument();
  });
});
