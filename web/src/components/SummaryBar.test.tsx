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

  it('carries the token rate behind the disclosure, for narrow screens where the top bar drops it', () => {
    const tail = (...v: number[]) => [...new Array<number>(60 - v.length).fill(0), ...v];
    const minute = Date.UTC(2026, 9, 23, 2, 0, 0);
    const rate = {
      minute: new Date(minute).toISOString(),
      at: new Date(minute + 30_000).toISOString(),
      since: new Date(minute - 3_600_000).toISOString(),
      agents: {
        codex: {
          input: tail(0),
          cacheRead: tail(90_000, 90_000, 90_000, 90_000, 45_000),
          cacheWrite: tail(0),
          output: tail(0),
        },
      },
      coverage: { running: 2, counted: 1, agents: { codex: { running: 2, counted: 1 } } },
    };
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="main" rate={rate} rateAgent="codex" />
      </I18nContext.Provider>,
    );
    expect(value('Token rate')).toBe('≈90K/min');
    const cell = within(screen.getByRole('region', { name: 'Summary' })).getByText(
      'Token rate',
    ).parentElement;
    expect(cell).toHaveAttribute('data-narrow-only');
    expect(cell).toHaveAttribute('data-extra');
  });
});
