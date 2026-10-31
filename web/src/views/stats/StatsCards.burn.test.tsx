import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoQuotas } from '../../../../src/core/fixtures/demo.js';
import { emptyUsage } from '../../../../src/core/usage.js';
import type { QuotaBurn } from '../../../../src/shared/quota-burn.js';
import { createStore, StoreContext } from '../../data/store';
import { I18nContext, type Locale, makeI18n } from '../../i18n';
import { sessionLink } from '../../router';
import { DEMO_NOW } from '../../test/demo';
import { NowCard } from './StatsCards';

const NOW = DEMO_NOW.getTime();

function burnOf(provider: string, tokens: number[]): QuotaBurn {
  const total = tokens.reduce((a, b) => a + b, 0);
  return {
    provider,
    since: NOW - 3_600_000,
    asOf: NOW,
    sessions: tokens.map((n, i) => ({
      id: `s${i + 1}`,
      agent: 'claude-code',
      project: 'demo',
      cwd: null,
      title: `Task s${i + 1}`,
      usage: { ...emptyUsage(), cacheRead: n },
      requests: 2,
      tokens: n,
      share: n / total,
    })),
    tokens: total,
    counted: 'tokens',
  };
}

function renderCard(locale: Locale = 'en') {
  // Copilot is closest to its limit, but no session here used it: Claude's list is named.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const provider = new URL(url, 'http://x').searchParams.get('provider') ?? '';
      const tokens = provider === 'anthropic' ? [700, 200, 70, 30] : [];
      return new Response(JSON.stringify(burnOf(provider, tokens)));
    }),
  );
  const store = createStore();
  store.applyEvent({
    type: 'sessions',
    sessions: [{ id: 's1' } as never],
  });
  return render(
    <StoreContext.Provider value={store}>
      <I18nContext.Provider value={makeI18n(locale)}>
        <NowCard quotas={createDemoQuotas(DEMO_NOW)} now={NOW} />
      </I18nContext.Provider>
    </StoreContext.Provider>,
  );
}

describe('the Right now card’s Who used it', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the top three of the plan closest to a limit that glassbox saw used, in one line', async () => {
    renderCard();
    const card = screen.getByRole('region', { name: /Right now/i });
    const line = await waitFor(() => within(card).getByText(/^Who used/).parentElement);
    expect(line?.textContent).toBe(
      'Who used Claude · 5-hour window: Task s1 70% · Task s2 20% · Task s3 7%',
    );
    expect(line?.getAttribute('title')).toMatch(
      /^Shares of the tokens glassbox saw on this machine/,
    );
    // A listed session is a link; one the list does not have is plain text.
    expect(
      within(line as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe(sessionLink('s1'));
    expect(within(line as HTMLElement).getByText('Task s2').tagName).toBe('SPAN');
  });

  it('speaks Chinese', async () => {
    renderCard('zh');
    const card = screen.getByRole('region', { name: /此刻/ });
    await waitFor(() => expect(within(card).getByText(/的用量：/)).toBeTruthy());
  });
});
