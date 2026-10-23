import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OpenSession } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import type { Route } from '../../router';
import { demoOpen } from '../../test/demo';
import { useFakeLayout } from '../../test/layout';
import { UiContext } from '../../ui';
import { FlowView } from './FlowView';

// Count request-card renders: unrelated store events must not re-render every visible row.
const renders = vi.hoisted(() => ({ n: 0 }));
vi.mock('./cards', async (importOriginal) => {
  const real = await importOriginal<typeof import('./cards')>();
  return {
    ...real,
    RequestCard: (props: Parameters<typeof real.RequestCard>[0]) => {
      renders.n++;
      return real.RequestCard(props);
    },
  };
});

const en = makeI18n('en');
const ui = { follow: false, setFollow: () => {} };

function tree(open: OpenSession) {
  const route: Route = {
    sessionId: open.id,
    agentId: 'main',
    tab: 'flow',
    turnId: 'turn_m1',
    requestId: null,
  };
  return (
    <I18nContext.Provider value={en}>
      <UiContext.Provider value={ui}>
        <FlowView open={open} agentId="main" route={route} navigate={() => {}} />
      </UiContext.Provider>
    </I18nContext.Provider>
  );
}

describe('CallRow re-rendering', () => {
  useFakeLayout();

  it('skips rows whose request, tools and spawned agents did not change', () => {
    const open = demoOpen();
    const { rerender } = render(tree(open));
    const settled = renders.n;
    expect(settled).toBeGreaterThan(0);
    // A patch for an unrelated entity: a new open object with new request/tool maps.
    const patched: OpenSession = {
      ...open,
      requests: new Map(open.requests),
      toolCalls: new Map(open.toolCalls),
      session: { ...open.session, updatedAt: new Date().toISOString() },
    };
    rerender(tree(patched));
    expect(renders.n).toBe(settled);
  });

  it('re-renders a row whose request changed', () => {
    const open = demoOpen();
    const { rerender } = render(tree(open));
    const settled = renders.n;
    const m2 = open.requests.get('req_m2');
    if (!m2) throw new Error('fixture');
    rerender(
      tree({ ...open, requests: new Map(open.requests).set('req_m2', { ...m2, effort: 'low' }) }),
    );
    expect(renders.n).toBe(settled + 1);
  });
});
