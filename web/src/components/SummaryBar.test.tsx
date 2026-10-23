import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nContext, makeI18n } from '../i18n';
import { demoOpen } from '../test/demo';
import { SummaryBar } from './SummaryBar';

const value = (label: string) =>
  within(screen.getByRole('region', { name: 'Summary' }))
    .getByText(label)
    .parentElement?.querySelector('[data-value]')?.textContent;

describe('SummaryBar', () => {
  it('shows a dash, not 0ms, for an agent that has made no model call', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="nobody" />
      </I18nContext.Provider>,
    );
    expect(value('Model calls')).toBe('0');
    expect(value('Duration')).toBe('—');
  });

  it('shows the time spent once there are calls', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="main" />
      </I18nContext.Provider>,
    );
    expect(value('Duration')).not.toBe('—');
  });

  it('shows dashes, not zeros, for token figures no call has reported', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="nobody" />
      </I18nContext.Provider>,
    );
    expect(value('Input')).toBe('—');
    expect(value('Cache hit')).toBe('—');
    expect(value('Output (thinking)')).toBe('—');
  });

  it('keeps four figures on narrow screens and the rest behind a disclosure', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="main" />
      </I18nContext.Provider>,
    );
    const bar = screen.getByRole('region', { name: 'Summary' });
    const extra = [...bar.querySelectorAll('[data-extra]')].map(
      (m) => m.querySelector('.section-label')?.textContent,
    );
    expect(extra).toEqual(['Tool calls', 'Input', 'Cache hit']);
    const more = within(bar).getByRole('button', { name: 'More figures' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(bar).toHaveAttribute('data-more');
    expect(within(bar).getByRole('button', { name: 'Fewer figures' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
