import { fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeI18n } from '../i18n';
import { lazyView } from '../lib/lazy-view';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('kaboom');
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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

  // I3b parked item, final review P1: React.lazy keeps a failed import, so "Try again" would throw
  // the same error forever. A tab left open across an upgrade asks for chunks that are gone;
  // only loading the page again fetches the new ones.
  it.each([
    ['en', 'Reload', 'This view’s code could not load'],
    ['zh', '重新加载', '这个视图的代码没能加载'],
  ] as const)(
    'offers a page reload, never Try again, when a view’s code fails to load (%s)',
    async (locale, reloadName, says) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const reload = vi.fn();
      vi.stubGlobal('location', { ...window.location, reload });
      const View = lazyView(() =>
        Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/x.js')),
      );
      render(
        <I18nContext.Provider value={makeI18n(locale)}>
          <ErrorBoundary>
            <Suspense fallback={null}>
              <View />
            </Suspense>
          </ErrorBoundary>
        </I18nContext.Provider>,
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(says);
      expect(screen.queryByRole('button', { name: /Try again|重试/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: reloadName }));
      expect(reload).toHaveBeenCalledOnce();
    },
  );
});
