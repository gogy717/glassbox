import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeI18n } from '../i18n';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('kaboom');
}

describe('ErrorBoundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the rest of the app alive and says what broke', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <p>still here</p>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </I18nContext.Provider>,
    );
    expect(screen.getByText('still here')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This view hit an error: kaboom');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
