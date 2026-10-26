import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createDemoQuotas } from '../../../../src/core/fixtures/demo.js';
import { createStore, StoreContext } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import { priceTable } from '../../lib/prices';
import { DEMO_NOW } from '../../test/demo';
import { demoWeek } from '../../test/week';
import { NowCard, TokensCard } from './StatsCards';
import { statsWeek } from './statsData';

describe('the Right now card', () => {
  it('colours each plan as the top bar’s meter does: amber when its limit comes before its reset', () => {
    render(
      <StoreContext.Provider value={createStore()}>
        <I18nContext.Provider value={makeI18n('en')}>
          <NowCard quotas={createDemoQuotas(DEMO_NOW)} now={DEMO_NOW.getTime()} />
        </I18nContext.Provider>
      </StoreContext.Provider>,
    );
    const card = screen.getByRole('region', { name: /Right now/i });
    const levels = within(card)
      .getAllByRole('listitem')
      .map((li) => [li.textContent?.split(/\d/)[0], li.getAttribute('data-level')]);
    // Copilot: 74% used with 71% of its month gone, so the limit comes first.
    expect(levels).toEqual([
      ['Claude', 'ok'],
      ['ChatGPT', 'ok'],
      ['Grok', 'ok'],
      ['Copilot', 'warn'],
    ]);
  });
});

// Proposal 6: the window's tokens as the API would have billed them.
describe('the Tokens card', () => {
  const TITLE =
    'What these tokens would cost on the API, estimated from the price table in Settings';
  const cost = () => {
    const card = screen.getByRole('region', { name: /Tokens/i });
    const label = within(card).getByText('API cost (est.)');
    return label.parentElement as HTMLElement;
  };
  const renderCard = (w: ReturnType<typeof statsWeek>, locale: 'en' | 'zh' = 'en') =>
    render(
      <I18nContext.Provider value={makeI18n(locale)}>
        <TokensCard w={w} locale={locale} />
      </I18nContext.Provider>,
    );

  it('says what the window’s tokens would cost on the API, and what it leaves out', () => {
    renderCard(statsWeek(demoWeek(), false));
    // The week's Claude calls at list prices: $140.78; Codex's model has no price.
    expect(cost().querySelector('.figure')).toHaveTextContent('≈ $141');
    expect(cost()).toHaveAttribute('title', `${TITLE} · Left out, no price: gpt-5.5-codex`);
  });

  it('prices by the table given, and shows a dash when no model has a price', () => {
    const twice = (input: number, read: number) => ({
      input: input * 2,
      cacheWrite: input * 2.5,
      cacheWrite1h: input * 4,
      cacheRead: read * 2,
      output: input * 10,
    });
    const own = priceTable({
      'claude-opus-5-5': twice(4, 0.2),
      'claude-sonnet-5-5': twice(2, 0.1),
    });
    const { unmount } = renderCard(statsWeek(demoWeek(), false, own));
    // Twice the list prices: twice $140.78.
    expect(cost().querySelector('.figure')).toHaveTextContent('≈ $282');
    unmount();
    renderCard(statsWeek(demoWeek(), false, {}));
    expect(cost().querySelector('.figure')).toHaveTextContent('—');
    expect(cost()).toHaveAttribute(
      'title',
      `${TITLE} · Left out, no price: claude-opus-5-5, claude-sonnet-5-5, gpt-5.5-codex`,
    );
  });

  it('speaks Chinese', () => {
    renderCard(statsWeek(demoWeek(), false), 'zh');
    const card = screen.getByRole('region', { name: /TOKEN/ });
    expect(within(card).getByText('API 费用（估）')).toBeInTheDocument();
  });
});
