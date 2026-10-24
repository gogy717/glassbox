import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_ID } from '../../../src/core/model.js';
import { WAIT_MS } from '../components/Delayed';
import { I18nContext, makeI18n } from '../i18n';
import { demoOpen } from '../test/demo';
import { UiContext } from '../ui';
import { SessionView } from './SessionView';

/** The Timeline's chunk, held back until the test lets it arrive. */
const chunk = vi.hoisted(() => {
  let release = () => {};
  const arrived = new Promise<void>((r) => {
    release = r;
  });
  return { arrived, release: () => release() };
});
vi.mock('./time/TimeView', async () => {
  await chunk.arrived;
  return { TimeView: () => <p>the timeline</p> };
});

// F-web W8: a view's chunk is usually local and quick; "Loading…" waits 200 ms to say so.
describe('SessionView loading a chart view', () => {
  it('says "Loading…" only once the chunk has taken 200 ms, then shows the view', async () => {
    const open = demoOpen();
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <UiContext.Provider value={{ follow: true, setFollow: vi.fn() }}>
          <SessionView
            open={open}
            route={{
              sessionId: open.id,
              agentId: MAIN_AGENT_ID,
              tab: 'time',
              turnId: null,
              requestId: null,
            }}
            navigate={vi.fn()}
          />
        </UiContext.Provider>
      </I18nContext.Provider>,
    );
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(await screen.findByText('Loading…', {}, { timeout: WAIT_MS * 5 })).toBeInTheDocument();
    await act(async () => chunk.release());
    expect(await screen.findByText('the timeline')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});
