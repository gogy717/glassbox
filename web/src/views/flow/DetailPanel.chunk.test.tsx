import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequest } from '../../../../src/core/model.js';
import { I18nContext, makeI18n } from '../../i18n';
import { demoOpen } from '../../test/demo';
import { DetailPanel } from './DetailPanel';
import { resetDetailPrefs } from './detail/prefs';

// After an upgrade an open tab asks for a chunk that is gone: the Context tab's never arrives.
vi.mock('./detail/ContextView', () => {
  throw new Error('chunk gone');
});

const open = demoOpen();

describe('DetailPanel when the Context tab cannot load', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    resetDetailPrefs();
  });

  it('keeps what was sent, and says the tab’s code is gone, offering a reload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              requestId: 'req_m1',
              completeness: 'full',
              notes: [],
              params: null,
              system: 'You are…',
              tools: [],
              messages: [{ role: 'user', content: 'Busy sessions first' }],
            }),
          ),
      ),
    );
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <DetailPanel
          sessionId={open.id}
          req={open.requests.get('req_m1') as ModelRequest}
          tools={[]}
          card="request"
          onClose={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    const panel = screen.getByRole('region', { name: 'Request details' });
    expect(await within(panel).findByText('Fully reconstructed')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('radio', { name: 'Context' }));
    expect(await within(panel).findByText(/code could not load/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    // No bill, nothing to copy.
    expect(within(panel).queryByRole('button', { name: 'Copy' })).toBeNull();
    fireEvent.click(within(panel).getByRole('radio', { name: 'Details' }));
    expect(within(panel).getByRole('heading', { name: 'Messages' })).toBeInTheDocument();
  });
});
