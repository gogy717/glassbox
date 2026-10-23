import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nContext, makeI18n } from '../i18n';
import { Ticking } from './Status';

describe('Ticking', () => {
  it('shows a dash rather than NaN for a malformed start time', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <Ticking since="not a time" labelKey="flow.thinkingNow" />
      </I18nContext.Provider>,
    );
    expect(screen.getByText('Thinking · —')).toBeInTheDocument();
  });
});
