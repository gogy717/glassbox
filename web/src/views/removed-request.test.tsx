import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequest, SessionPatch, Turn } from '../../../src/core/model.js';
import type { OpenSession } from '../data/store';
import { I18nContext, makeI18n } from '../i18n';
import type { Route } from '../router';
import { DEMO_NOW, demoStore } from '../test/demo';
import { useFakeLayout } from '../test/layout';
import { UiContext } from '../ui';
import { FlowView } from './flow/FlowView';
import { StepsView } from './steps/StepsView';
import { TimeView } from './time/TimeView';

/**
 * Claude Code sometimes re-issues a request; the adapter first reports the abandoned one as
 * in flight, then removes it. Nothing may keep showing it as "thinking".
 */
function storeWithRemovedGhost() {
  const store = demoStore();
  const open = store.getState().open as OpenSession;
  const base = (patch: Partial<SessionPatch>): SessionPatch => ({
    session: open.session,
    agents: [],
    turns: [],
    requests: [],
    toolCalls: [],
    workflows: [],
    diagnostics: null,
    ...patch,
  });
  const m6 = open.requests.get('req_m6') as ModelRequest;
  const ghost: ModelRequest = { ...m6, id: 'req_ghost', index: 2 };
  const turn = open.turns.get('turn_m3') as Turn;
  store.applyEvent({
    type: 'patch',
    sessionId: open.id,
    patch: base({ requests: [ghost], turns: [{ ...turn, requestIds: ['req_m6', 'req_ghost'] }] }),
  });
  store.applyEvent({
    type: 'patch',
    sessionId: open.id,
    patch: base({ removed: { requests: ['req_ghost'] } }),
  });
  return store.getState().open as OpenSession;
}

function wrap(node: React.ReactNode) {
  return render(
    <I18nContext.Provider value={makeI18n('en')}>
      <UiContext.Provider value={{ follow: true, setFollow: () => {} }}>{node}</UiContext.Provider>
    </I18nContext.Provider>,
  );
}

const route = (open: OpenSession, tab: Route['tab']): Route => ({
  sessionId: open.id,
  agentId: 'main',
  tab,
  turnId: null,
  requestId: null,
});

describe('a request removed by a patch', () => {
  useFakeLayout();
  afterEach(() => vi.useRealTimers());

  it('is gone from the execution chain, and follow mode stays on the real last call', () => {
    const open = storeWithRemovedGhost();
    wrap(<FlowView open={open} agentId="main" route={route(open, 'flow')} navigate={() => {}} />);
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual([
      'Model call #1',
    ]);
    // Turn card and turn header both count one call, never the ghost.
    expect(screen.getByRole('button', { name: /Conversation 3/ })).toHaveTextContent(
      '1 call · 0 tools',
    );
    expect(screen.getByRole('group', { name: 'Conversation 3' })).toHaveTextContent(
      '1 model call · 0 tools',
    );
    expect(screen.queryByText('2 model calls · 0 tools')).toBeNull();
  });

  it('is gone from the steps', () => {
    const open = storeWithRemovedGhost();
    wrap(<StepsView open={open} agentId="main" route={route(open, 'steps')} navigate={() => {}} />);
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual([
      'Step 1',
    ]);
  });

  it('is gone from the timeline', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(DEMO_NOW);
    const open = storeWithRemovedGhost();
    wrap(<TimeView open={open} agentId="main" navigate={() => {}} />);
    const svg = screen.getByRole('img', { name: 'Timeline per agent' });
    expect(svg.querySelector('[data-ref="req_ghost"]')).toBeNull();
    expect(svg.querySelector('[data-ref="req_m6"]')).not.toBeNull();
  });
});
