import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nContext, makeI18n } from '../i18n';
import { LiveDot, StatusMark, Ticking, type UiStatus } from './Status';

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

describe('StatusMark', () => {
  const renderMark = (status: UiStatus, compact = false) =>
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <StatusMark status={status} compact={compact} />
      </I18nContext.Provider>,
    );

  it.each([
    ['running', 'Running', 'dot'],
    ['approval', 'Waiting for you', 'dot'],
    ['complete', 'Complete', 'glyph'],
    ['error', 'Failed', 'glyph'],
    ['interrupted', 'Interrupted', 'dot'],
    ['waiting', 'Waiting', 'dot'],
  ] as const)('%s: a %s mark and its word, no pill', (status, word, kind) => {
    const { container } = renderMark(status);
    const mark = container.firstElementChild as HTMLElement;
    expect(mark).toHaveAttribute('data-state', status);
    expect(screen.getByText(word)).toHaveAttribute('data-status-label');
    // A check or an × for the ends, a dot for the states in between; never an icon in a pill.
    expect(mark.querySelector('svg') !== null).toBe(kind === 'glyph');
  });

  it('in a dense list shows the mark alone, named by its word', () => {
    renderMark('complete', true);
    const mark = screen.getByRole('img', { name: 'Complete' });
    expect(mark).toHaveAttribute('title', 'Complete');
    expect(screen.queryByText('Complete')).toBeNull();
  });
});
