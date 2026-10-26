import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_ID } from '../../../src/core/model.js';
import { I18nContext, makeI18n } from '../i18n';
import { demoOpen } from '../test/demo';
import { UiContext } from '../ui';
import { SessionView } from './SessionView';

// After an upgrade an open tab asks for a chunk that is gone: the strip's never arrives.
vi.mock('../components/OutcomeStrip', () => {
  throw new Error('chunk gone');
});

describe('SessionView when the outcome strip cannot load', () => {
  it('shows the session all the same, without the strip', async () => {
    const open = demoOpen();
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <UiContext.Provider value={{ follow: true, setFollow: vi.fn() }}>
          <SessionView
            open={open}
            route={{
              sessionId: open.id,
              agentId: MAIN_AGENT_ID,
              tab: 'steps',
              turnId: null,
              requestId: null,
            }}
            navigate={vi.fn()}
          />
        </UiContext.Provider>
      </I18nContext.Provider>,
    );
    await act(async () => {});
    expect(screen.getByRole('region', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Outcome' })).toBeNull();
  });
});
