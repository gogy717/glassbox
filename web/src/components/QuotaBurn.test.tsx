import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoQuota } from '../../../src/core/fixtures/demo.js';
import { emptyUsage } from '../../../src/core/usage.js';
import { type BurnSession, burnSince, type QuotaBurn } from '../../../src/shared/quota-burn.js';
import type { BurnState } from '../data/quotaBurn';
import { I18nContext, type Locale, makeI18n } from '../i18n';
import { sessionLink } from '../router';
import { DEMO_NOW } from '../test/demo';
import { QuotaBar } from './QuotaBar';
import { QuotaBurnList, sharePct } from './QuotaBurn';

const NOW = DEMO_NOW.getTime();
const HOUR = 3_600_000;

const row = (id: string, tokens: number, total: number, requests = 3): BurnSession => ({
  id,
  agent: 'claude-code',
  project: 'demo',
  cwd: null,
  title: `Task ${id}`,
  usage: { ...emptyUsage(), cacheRead: tokens },
  requests,
  tokens,
  share: tokens / total,
});

function burnOf(tokens: number[], counted: QuotaBurn['counted'] = 'tokens'): QuotaBurn {
  const total = tokens.reduce((a, b) => a + b, 0);
  return {
    provider: 'anthropic',
    since: NOW - 2 * HOUR,
    asOf: NOW,
    sessions: tokens.map((n, i) => row(`s${i + 1}`, n, total)),
    tokens: total,
    counted,
  };
}

function renderList(state: BurnState, listed: Set<string> | null = null, locale: Locale = 'en') {
  return render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <QuotaBurnList state={state} now={NOW} listed={listed} />
    </I18nContext.Provider>,
  );
}

describe('Who used it', () => {
  it('lists the top five with their shares and tokens, then how many more', () => {
    renderList({
      status: 'ok',
      burn: burnOf([600_000, 200_000, 90_000, 50_000, 30_000, 20_000, 10_000]),
    });
    const list = screen.getByRole('list', { name: 'Who used it' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(rows[0]?.textContent).toBe('Task s1 · Claude Code60%600K');
    expect(rows[0]?.getAttribute('title')).toBe(
      'Task s1: 60% · 600K tokens · 3 requests · Claude Code',
    );
    expect(screen.getByText('and 2 more · 3%')).toBeTruthy();
    expect(
      screen.getByText(
        'Shares of the tokens glassbox saw on this machine, cache reads included; other machines and apps are not seen.',
      ),
    ).toBeTruthy();
  });

  it('opens a listed session from its row; one not listed is plain text', () => {
    renderList({ status: 'ok', burn: burnOf([3, 2, 1]) }, new Set(['s1', 's3']));
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      sessionLink('s1'),
      sessionLink('s3'),
    ]);
    expect(screen.getByText('Task s2').tagName).toBe('SPAN');
  });

  it('shares by requests when the sessions report no tokens, and says so', () => {
    const burn = burnOf([0, 0], 'requests');
    burn.sessions = burn.sessions.map((s, i) => ({
      ...s,
      requests: i ? 1 : 3,
      share: i ? 0.25 : 0.75,
    }));
    renderList({ status: 'ok', burn });
    expect(screen.getAllByRole('listitem')[0]?.textContent).toBe('Task s1 · Claude Code75%3');
    expect(screen.getByText(/report no tokens, so the shares are of their requests/)).toBeTruthy();
  });

  it('says when it is reading, could not read, or saw nothing', () => {
    const { unmount } = renderList({ status: 'reading' });
    expect(screen.getByText('Reading sessions…')).toBeTruthy();
    unmount();
    renderList({ status: 'error' }).unmount();
    renderList({ status: 'ok', burn: burnOf([]) });
    expect(
      screen.getByText('glassbox saw no request to it on this machine in this window.'),
    ).toBeTruthy();
  });

  it('speaks Chinese', () => {
    renderList({ status: 'ok', burn: burnOf([5, 1, 1, 1, 1, 1]) }, null, 'zh');
    expect(screen.getByRole('list', { name: '谁用掉的' })).toBeTruthy();
    expect(screen.getByText('还有 1 个会话 · 10%')).toBeTruthy();
  });

  it('prints a share too small to round up as "<1%"', () => {
    expect(sharePct(0.004)).toBe('<1%');
    expect(sharePct(0)).toBe('0%');
    expect(sharePct(0.996)).toBe('100%');
  });
});

describe('Who used it, in the quota’s details', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the five-hour window’s list on open, and adds "mostly" to its pace', async () => {
    const quota = createDemoQuota(DEMO_NOW);
    const burn = { ...burnOf([700, 200, 100]), since: burnSince(quota, NOW) };
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify(burn)));
    vi.stubGlobal('fetch', fetch);
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <QuotaBar quotas={[quota]} now={NOW} />
      </I18nContext.Provider>,
    );
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Plan quota/ }));
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `/api/quota/burn?provider=anthropic&since=${burnSince(quota, NOW)}`,
    );
    const dialog = screen.getByRole('dialog', { name: 'Plan quota' });
    await waitFor(() => expect(within(dialog).getAllByRole('listitem')).toHaveLength(3));
    const paces = [...dialog.querySelectorAll('[data-verdict]')].map((p) => p.textContent);
    expect(paces.filter((p) => p?.includes('mostly Task s1'))).toHaveLength(1);
    // Following a row's link closes the details.
    fireEvent.click(within(dialog).getAllByRole('link')[0] as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
