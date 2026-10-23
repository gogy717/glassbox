import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nContext, makeI18n } from '../i18n';
import { LiveDot, Ticking } from './Status';

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

describe('LiveDot', () => {
  it('is decoration next to its state’s name, and names the state when it stands alone', () => {
    const { container, rerender } = render(<LiveDot state="complete" />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).toBeNull();
    rerender(<LiveDot state="complete" label="Complete" />);
    const dot = screen.getByRole('img', { name: 'Complete' });
    expect(dot).toHaveAttribute('title', 'Complete');
    expect(dot).toHaveAttribute('data-state', 'complete');
  });
});
