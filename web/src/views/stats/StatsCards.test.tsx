import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createDemoQuotas } from '../../../../src/core/fixtures/demo.js';
import { createStore, StoreContext } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import { DEMO_NOW } from '../../test/demo';
import { NowCard } from './StatsCards';

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
