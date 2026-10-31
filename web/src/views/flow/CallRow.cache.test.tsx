import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '../../../../src/core/fixtures/demo.js';
import { stageCacheBreaks } from '../../../../src/server/demo-cache-breaks.js';
import { fromSnapshot, type OpenSession } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import type { Route } from '../../router';
import { cjkInMono } from '../../test/cjk';
import { DEMO_NOW, demoOpen } from '../../test/demo';
import { useFakeLayout } from '../../test/layout';
import { UiContext } from '../../ui';
import { FlowView } from './FlowView';

afterEach(cleanup);

const ui = { follow: false, setFollow: () => {} };

const staged = (): OpenSession => {
  const snap = stageCacheBreaks(createDemoSnapshot(DEMO_NOW));
  return fromSnapshot(snap.session.id, snap);
};

function renderTurn(
  open: OpenSession,
  agentId: string,
  turnId: string,
  locale: 'en' | 'zh' = 'en',
) {
  const route: Route = { sessionId: open.id, agentId, tab: 'flow', turnId, requestId: null };
  return render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <UiContext.Provider value={ui}>
        <FlowView open={open} agentId={agentId} route={route} navigate={() => {}} />
      </UiContext.Provider>
    </I18nContext.Provider>,
  );
}

const row = (n: number) =>
  screen.getAllByRole('article', { name: `Model call #${n}` })[0] as HTMLElement;

describe('a request that broke the prompt cache', () => {
  useFakeLayout();

  it('carries a muted tag saying why, the reason in a sentence as its tooltip', () => {
    renderTurn(staged(), 'main', 'turn_m1');
    const tag = screen.getByText('cache · prompt changed');
    expect(row(2)).toContainElement(tag);
    expect(tag).toHaveAttribute(
      'title',
      expect.stringMatching(/^The cache broke: the system prompt or the tools changed/),
    );
    expect(row(1)).not.toHaveTextContent('cache ·');
    expect(row(3)).not.toHaveTextContent('cache ·');
  });

  it('says expired after a long wait, with how long and how long the cache lives', () => {
    renderTurn(staged(), 'af00000000000001', 'turn_w1');
    const tag = screen.getByText('cache · expired');
    expect(row(4)).toContainElement(tag);
    expect(tag.getAttribute('title')).toBe(
      'The cache broke: 6m31s passed since the previous request, longer than the cache lives (5 minutes).',
    );
  });

  it('is not shown where the cache held', () => {
    renderTurn(demoOpen(), 'main', 'turn_m1');
    expect(screen.queryByText(/^cache ·/)).toBeNull();
  });

  it('speaks Chinese in the UI face', () => {
    const { container } = renderTurn(staged(), 'af00000000000002', 'turn_w2', 'zh');
    expect(screen.getByText('缓存 · 已压缩')).toBeInTheDocument();
    expect(screen.getByText('缓存 · 回退')).toBeInTheDocument();
    expect(cjkInMono(container)).toEqual([]);
  });
});
