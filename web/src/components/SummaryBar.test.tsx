import { render, screen, within } from '@testing-library/react';
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
});
