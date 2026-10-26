import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, type Locale, makeI18n } from '../i18n';
import { DEFAULT_PRICES } from '../lib/prices';
import { loadPrefs, type Prefs } from '../prefs';
import { TopBar } from './TopBar';

// jsdom applies no media queries: the thresholds are read from the sheet itself.
const sheet = readFileSync(join(import.meta.dirname, 'TopBar.module.css'), 'utf8');

/** Each `@media (max-width: …)` block of the sheet: its width and what it holds. */
function mediaBlocks(css: string): { max: number; body: string }[] {
  const blocks: { max: number; body: string }[] = [];
  const head = /@media \(max-width: (\d+)px\) \{/g;
  for (let m = head.exec(css); m; m = head.exec(css)) {
    let depth = 1;
    let i = head.lastIndex;
    for (; i < css.length && depth > 0; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
    blocks.push({ max: Number(m[1]), body: css.slice(head.lastIndex, i - 1) });
  }
  return blocks;
}

/** The sheet with its media blocks taken out: what holds at every width. */
function baseRules(css: string): string {
  let out = css;
  for (const b of mediaBlocks(css)) out = out.replace(b.body, '');
  return out;
}

type Props = Parameters<typeof TopBar>[0];

const navOf = (page: Props['nav']['page'], inbox = 0): Props['nav'] => ({
  page,
  here: page === 'home' ? '#/' : page === 'session' ? '#/s/x' : `#/${page}`,
  session: { href: '#/s/x', waiting: false },
  sessionsLoaded: true,
  inbox,
});

function renderBar(over: Partial<Props> = {}) {
  const { container } = render(
    <I18nContext.Provider value={makeI18n('en')}>
      <TopBar
        nav={navOf('home')}
        title={null}
        agent={null}
        sidebarId="session-list"
        sidebarOpen
        live={null}
        connection="open"
        quotas={[]}
        follow
        onFollow={() => {}}
        prefs={loadPrefs()}
        onPrefs={() => {}}
        onToggleSidebar={() => {}}
        {...over}
      />
    </I18nContext.Provider>,
  );
  return within(container);
}

// F5: Follow latest is a session-page control; the connection is news only while it is not
// connected.
describe('the top bar by page', () => {
  it.each(['home', 'stats'] as const)('offers no Follow latest on %s', (page) => {
    expect(
      renderBar({ nav: navOf(page) }).queryByRole('button', { name: 'Follow latest' }),
    ).toBeNull();
  });

  it('offers Follow latest on the session page, pressed while following', () => {
    const bar = renderBar({ nav: navOf('session'), title: 'A session', agent: 'claude-code' });
    expect(bar.getByRole('button', { name: 'Follow latest' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('says the connection as a status while it is not open, and hides the word once it is', () => {
    expect(renderBar({ connection: 'connecting' }).getByRole('status')).toHaveTextContent(
      'Connecting',
    );
    const dropped = renderBar({ connection: 'reconnecting' }).getByRole('status');
    expect(dropped).toHaveTextContent('Disconnected, reconnecting…');
    expect(dropped).toHaveAttribute('data-state', 'reconnecting');
    // Connected: still in the page for the status region, read but not seen, at every width.
    const open = renderBar({ connection: 'open' }).getByRole('status');
    expect(open).toHaveAttribute('data-state', 'open');
    expect(baseRules(sheet)).toMatch(/\.conn\[data-state="open"\] \{[^}]*clip-path: inset\(50%\)/);
    for (const block of mediaBlocks(sheet)) expect(block.body).not.toMatch(/\.conn\b/);
  });
});

describe('the Inbox in the page nav', () => {
  const nav = (bar: ReturnType<typeof renderBar>) => bar.getByRole('navigation', { name: 'Pages' });

  it('comes after Stats, linking the Inbox, marked while it is open', () => {
    const bar = renderBar({ nav: navOf('home') });
    expect(
      within(nav(bar))
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Home', 'Session', 'Stats', 'Inbox']);
    const inbox = within(nav(bar)).getByRole('link', { name: 'Inbox' });
    expect(inbox).toHaveAttribute('href', '#/inbox');
    expect(inbox).not.toHaveAttribute('aria-current');
    const open = renderBar({ nav: { ...navOf('inbox'), here: '#/inbox?item=s1' } });
    const here = within(nav(open)).getByRole('link', { name: 'Inbox' });
    expect(here).toHaveAttribute('aria-current', 'page');
    expect(here).toHaveAttribute('href', '#/inbox?item=s1');
  });

  it('counts what waits for you on it, in the mono face, and says so to a screen reader', () => {
    const bar = renderBar({ nav: navOf('home', 3) });
    const inbox = within(nav(bar)).getByRole('link', { name: 'Inbox' });
    const badge = within(inbox).getByText('3');
    expect(badge).toHaveClass('figure');
    expect(badge).toHaveAttribute('data-badge');
    expect(inbox).toHaveAccessibleDescription('3 waiting for you');
    expect(inbox).toHaveAttribute('title', 'Inbox · 3 waiting for you');
  });

  it('shows no count while nothing waits', () => {
    const inbox = within(nav(renderBar({ nav: navOf('home', 0) }))).getByRole('link', {
      name: 'Inbox',
    });
    expect(inbox.querySelector('[data-badge]')).toBeNull();
    expect(inbox).not.toHaveAttribute('aria-describedby');
    expect(inbox).toHaveAttribute('title', 'Inbox');
  });
});

describe('Jump to…', () => {
  it.each(['home', 'session', 'stats'] as const)(
    'sits beside Settings on %s, naming its keys, and opens the palette',
    (page) => {
      const onJump = vi.fn();
      const bar = renderBar({ nav: navOf(page), onJump });
      const jump = bar.getByRole('button', { name: 'Jump to…' });
      expect(jump).toHaveAttribute('aria-keyshortcuts', 'Control+K');
      expect(jump).toHaveTextContent('Jump to…Ctrl K');
      expect(jump.nextElementSibling).toContainElement(
        bar.getByRole('button', { name: 'Settings' }),
      );
      fireEvent.click(jump);
      expect(onJump).toHaveBeenCalledOnce();
    },
  );

  it('gives up its word and keys below 1550 in a session, so the title keeps its 240px', () => {
    // Measured with Rules in the nav, beside the longest state ("Waiting for you"): with them, a
    // session's title had 210px at 1510 and 250px at 1550.
    const hiding = mediaBlocks(sheet).filter((b) =>
      /\.bar\[data-session\] \.jumpLabel/.test(b.body),
    );
    expect(hiding.map((b) => b.max)).toEqual([1549]);
    // Off a session, below 1200, with Follow latest's word.
    expect(mediaBlocks(sheet).some((b) => b.max === 1199 && /\.jumpLabel\b/.test(b.body))).toBe(
      true,
    );
  });
});

describe('the page nav', () => {
  const links = (page: Props['nav']['page']) =>
    within(renderBar({ nav: navOf(page) }).getByRole('navigation', { name: 'Pages' })).getAllByRole(
      'link',
    );

  it('links Rules after Stats, marked as the page you are on there', () => {
    const onRules = links('rules');
    expect(onRules.map((a) => a.textContent)).toEqual(['Home', 'Session', 'Stats', 'Rules']);
    expect(onRules[3]).toHaveAttribute('aria-current', 'page');
    expect(onRules[3]).toHaveAttribute('href', '#/rules');
    cleanup();
    const onHome = links('home');
    expect(onHome[3]).not.toHaveAttribute('aria-current');
    expect(onHome[3]).toHaveAttribute('href', '#/rules');
  });
});

describe('the top bar as it narrows (D4 DR1)', () => {
  it('drops the page nav words at one width on every page, a session included', () => {
    // Four words since Rules: with them, a session's title had 164px at 1200 and 244px at 1280
    // (English, measured).
    const hiding = mediaBlocks(sheet).filter((b) => /\.pageLabel\b/.test(b.body));
    expect(hiding.map((b) => b.max)).toEqual([1279]);
    // Nothing narrows the nav for one page only: no rule ties its words to an open session.
    expect(sheet).not.toMatch(/\[data-session\][^{,]*\.pageLabel/);
  });

  it('lets a session pay for its title with Follow latest’s word first, below 1470', () => {
    // Beside "Waiting for you", its word left a session's title 234px at 1460, 244px at 1470.
    const session = mediaBlocks(sheet).find((b) => b.max === 1469);
    expect(session?.body).toMatch(/\.bar\[data-session\] \.toggleLabel/);
    expect(session?.body).not.toMatch(/\.pageLabel/);
  });

  it('keeps the wordmark’s word out of a session below 1320, where the page nav has its words', () => {
    // Beside "Waiting for you", with both words, the title had 208px at 1280 and 248px at 1320.
    const session = mediaBlocks(sheet).find((b) => /\.bar\[data-session\] \.wordmark/.test(b.body));
    expect(session?.max).toBe(1319);
  });
});

/** The bar with prefs that change as Settings changes them, each change kept in `changes`. */
function PrefsHarness(p: { start: Partial<Prefs>; locale: Locale; changes: Prefs[] }) {
  const [prefs, setPrefs] = useState<Prefs>(() => ({ ...loadPrefs(), ...p.start }));
  return (
    <I18nContext.Provider value={makeI18n(p.locale)}>
      <TopBar
        nav={navOf('home')}
        title={null}
        agent={null}
        sidebarId="session-list"
        sidebarOpen
        live={null}
        connection="open"
        quotas={[]}
        follow
        onFollow={() => {}}
        prefs={prefs}
        onPrefs={(next) => {
          p.changes.push(next);
          setPrefs(next);
        }}
        onToggleSidebar={() => {}}
      />
    </I18nContext.Provider>
  );
}

/** Every change Settings makes to the prefs, in order. */
function renderWithPrefs(start: Partial<Prefs> = {}, locale: Locale = 'en') {
  const changes: Prefs[] = [];
  render(<PrefsHarness start={start} locale={locale} changes={changes} />);
  return changes;
}

const openPrices = (settings = 'Settings', label = 'API prices (estimate)') => {
  fireEvent.click(screen.getByRole('button', { name: settings }));
  fireEvent.click(screen.getByRole('button', { name: label }));
  return screen.getByRole('dialog', { name: label });
};

const cell = (dialog: HTMLElement, model: string, kind: string) =>
  within(dialog).getByRole('spinbutton', {
    name: `${model}: ${kind}, USD per million tokens`,
  }) as HTMLInputElement;

// Proposal 6: what the tokens would cost on the API, from a table the person can correct.
describe('API prices in Settings', () => {
  afterEach(() => localStorage.clear());

  it('opens the price table from Settings: a row per model, its five prices as inputs', () => {
    renderWithPrefs();
    const dialog = openPrices();
    // The settings popover gives way to the dialog.
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    const rows = within(dialog).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.querySelector('th')?.textContent)).toEqual(
      Object.keys(DEFAULT_PRICES),
    );
    expect(cell(dialog, 'claude-opus-5-5', 'Input').value).toBe('4');
    expect(cell(dialog, 'claude-opus-5-5', 'Cache write (5 min)').value).toBe('5');
    expect(cell(dialog, 'claude-opus-5-5', 'Cache write (1 h)').value).toBe('8');
    expect(cell(dialog, 'claude-opus-5-5', 'Cache read').value).toBe('0.2');
    expect(cell(dialog, 'claude-opus-5-5', 'Output').value).toBe('20');
    expect(dialog).toHaveTextContent('Oct 26, 2026');
    expect(within(dialog).getByRole('button', { name: 'Reset to defaults' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('keeps an edited price as the model’s whole row, and a number that is not one not at all', () => {
    const changes = renderWithPrefs();
    const dialog = openPrices();
    fireEvent.change(cell(dialog, 'claude-opus-5-5', 'Output'), { target: { value: '25' } });
    expect(changes.at(-1)?.prices).toEqual({
      'claude-opus-5-5': { input: 4, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 25 },
    });
    const before = changes.length;
    fireEvent.change(cell(dialog, 'claude-opus-5-5', 'Input'), { target: { value: '' } });
    fireEvent.change(cell(dialog, 'claude-opus-5-5', 'Input'), { target: { value: '-1' } });
    expect(changes).toHaveLength(before);
    const row = within(dialog).getByRole('rowheader', { name: /claude-opus-5-5/ });
    expect(row).toHaveTextContent('edited');
  });

  it('resets every price to the defaults', () => {
    const changes = renderWithPrefs({
      prices: {
        'claude-opus-5-5': { input: 1, cacheWrite: 1, cacheWrite1h: 1, cacheRead: 1, output: 1 },
      },
    });
    const dialog = openPrices();
    expect(cell(dialog, 'claude-opus-5-5', 'Input').value).toBe('1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset to defaults' }));
    expect(changes.at(-1)?.prices).toEqual({});
    expect(cell(dialog, 'claude-opus-5-5', 'Input').value).toBe('4');
  });

  // Final review #6: a button that disables itself drops focus out of the dialog's trap.
  it('keeps Reset to defaults focusable once there is nothing left to reset', () => {
    const changes = renderWithPrefs({
      prices: {
        'claude-opus-5-5': { input: 1, cacheWrite: 1, cacheWrite1h: 1, cacheRead: 1, output: 1 },
      },
    });
    const dialog = openPrices();
    const reset = within(dialog).getByRole('button', { name: 'Reset to defaults' });
    reset.focus();
    fireEvent.click(reset);
    expect(reset).not.toBeDisabled();
    expect(reset).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(reset);
    // Pressed again, it does nothing.
    const made = changes.length;
    fireEvent.click(reset);
    expect(changes).toHaveLength(made);
    fireEvent.keyDown(reset, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'API prices (estimate)' })).toBeNull();
  });

  it('adds a model the table does not price, and removes it again', () => {
    const changes = renderWithPrefs();
    const dialog = openPrices();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Add a model' }), {
      target: { value: ' gpt-5.5-codex ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(changes.at(-1)?.prices).toEqual({
      'gpt-5.5-codex': { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
    });
    fireEvent.change(cell(dialog, 'gpt-5.5-codex', 'Input'), { target: { value: '1.25' } });
    expect(changes.at(-1)?.prices['gpt-5.5-codex']?.input).toBe(1.25);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove gpt-5.5-codex' }));
    expect(changes.at(-1)?.prices).toEqual({});
    // A default model is reset, not removed.
    expect(within(dialog).queryByRole('button', { name: 'Remove claude-opus-5-5' })).toBeNull();
  });

  it('speaks Chinese', () => {
    renderWithPrefs({}, 'zh');
    const dialog = openPrices('设置', 'API 价格（估算）');
    const input = within(dialog).getByRole('spinbutton', {
      name: 'claude-opus-5-5：输入，美元/百万 token',
    }) as HTMLInputElement;
    expect(input.value).toBe('4');
    expect(within(dialog).getByRole('button', { name: '恢复默认' })).toBeInTheDocument();
  });
});
