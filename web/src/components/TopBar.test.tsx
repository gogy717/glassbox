import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nContext, makeI18n } from '../i18n';
import { loadPrefs } from '../prefs';
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

const navOf = (page: Props['nav']['page']): Props['nav'] => ({
  page,
  here: page === 'home' ? '#/' : page === 'stats' ? '#/stats' : '#/s/x',
  session: { href: '#/s/x', waiting: false },
  sessionsLoaded: true,
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

describe('the top bar as it narrows (D4 DR1)', () => {
  it('drops the page nav words at one width on all three pages, a session included', () => {
    const hiding = mediaBlocks(sheet).filter((b) => /\.pageLabel\b/.test(b.body));
    expect(hiding.map((b) => b.max)).toEqual([1199]);
    // Nothing narrows the nav for one page only: no rule ties its words to an open session.
    expect(sheet).not.toMatch(/\[data-session\][^{,]*\.pageLabel/);
  });

  it('lets a session pay for its title with Follow latest’s word first, below 1400', () => {
    const session = mediaBlocks(sheet).find((b) => b.max === 1399);
    expect(session?.body).toMatch(/\.bar\[data-session\] \.toggleLabel/);
    expect(session?.body).not.toMatch(/\.pageLabel/);
  });
});
