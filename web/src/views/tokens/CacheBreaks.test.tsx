import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoSnapshot } from '../../../../src/core/fixtures/demo.js';
import type { AgentKind } from '../../../../src/core/model.js';
import { stageCacheBreaks } from '../../../../src/server/demo-cache-breaks.js';
import { SessionAgentContext } from '../../data/session-agent';
import { fromSnapshot, type OpenSession } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import { cjkInMono } from '../../test/cjk';
import { DEMO_NOW, demoOpen } from '../../test/demo';
import { UiContext } from '../../ui';
import { CacheBreaks } from './CacheBreaks';

afterEach(cleanup);

const staged = (): OpenSession => {
  const snap = stageCacheBreaks(createDemoSnapshot(DEMO_NOW));
  return fromSnapshot(snap.session.id, snap);
};

function renderBreaks(
  open: OpenSession,
  { agentId = 'main', locale = 'en', kind = 'claude-code' } = {} as {
    agentId?: string;
    locale?: 'en' | 'zh';
    kind?: AgentKind;
  },
) {
  const navigate = vi.fn();
  const setFollow = vi.fn();
  const view = render(
    <SessionAgentContext.Provider value={kind}>
      <I18nContext.Provider value={makeI18n(locale)}>
        <UiContext.Provider value={{ follow: true, setFollow }}>
          <CacheBreaks open={open} agentId={agentId} navigate={navigate} />
        </UiContext.Provider>
      </I18nContext.Provider>
    </SessionAgentContext.Provider>,
  );
  return { navigate, setFollow, view };
}

describe('CacheBreaks', () => {
  it('shows nothing when the cache never broke', () => {
    const { view } = renderBreaks(demoOpen());
    expect(view.container).toBeEmptyDOMElement();
  });

  it('says how often the cache broke, what was written again and what it would cost', () => {
    renderBreaks(staged());
    const block = screen.getByRole('region', { name: /Cache breaks/ });
    expect(block).toHaveTextContent(/The cache broke 5 times · ≈ [\d.]+K tokens written again/);
    expect(block).toHaveTextContent(/≈\$[\d.]+ at API prices/);
    expect(within(block).getAllByRole('listitem')).toHaveLength(5);
  });

  it('words each break’s reason, with the reason in a sentence as its tooltip', () => {
    renderBreaks(staged());
    const rows = screen.getAllByRole('button');
    expect(rows.map((r) => r.querySelector('[data-reason]')?.textContent)).toEqual([
      'prompt changed',
      'compacted',
      'rewound',
      'cause unknown',
      'expired',
    ]);
    expect(rows[4]).toHaveAttribute(
      'title',
      expect.stringMatching(
        /^The cache broke: 6m31s passed since the previous request, longer than the cache lives \(5 minutes\)\.$/,
      ),
    );
    expect(rows[0]).toHaveAttribute('title', expect.stringMatching(/system prompt or the tools/));
  });

  it('names the agent of a break that is not the one shown', () => {
    renderBreaks(staged());
    const rows = screen.getAllByRole('button');
    expect(rows[0]).not.toHaveTextContent('recon');
    expect(rows[1]).toHaveTextContent('recon:prior-art');
  });

  it('opens the request in the execution chain', () => {
    const { navigate, setFollow } = renderBreaks(staged());
    fireEvent.click(screen.getAllByRole('button')[1] as HTMLElement);
    expect(setFollow).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledWith({
      tab: 'flow',
      agentId: 'af00000000000002',
      turnId: 'turn_w2',
      requestId: 'req_w2_4',
      card: 'request',
    });
  });

  it('keeps to the chosen agent and its sub-agents', () => {
    renderBreaks(staged(), { agentId: 'af00000000000001' });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('region')).toHaveTextContent('The cache broke 1 time');
  });

  it('is not available for a CLI without cache figures', () => {
    const open = staged();
    const grok = {
      ...open,
      diagnostics: { ...open.diagnostics, unavailable: ['per-request-usage'] },
    };
    renderBreaks(grok, { kind: 'grok' });
    const block = screen.getByRole('region', { name: /Cache breaks/ });
    expect(block).toHaveTextContent('Not available for Grok');
    expect(within(block).queryByRole('list')).toBeNull();
  });

  it('speaks Chinese, with no CJK in the mono face', () => {
    const { view } = renderBreaks(staged(), { locale: 'zh' });
    const block = screen.getByRole('region', { name: /缓存失效/ });
    expect(block).toHaveTextContent(/缓存失效了 5 次/);
    expect(block).toHaveTextContent('已过期');
    expect(cjkInMono(view.container)).toEqual([]);
  });
});
