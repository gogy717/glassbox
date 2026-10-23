import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentKind, QuotaSnapshot } from '../../../../src/core/model.js';
import { SessionAgentContext } from '../../data/session-agent';
import { createStore, StoreContext } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import { demoOpen } from '../../test/demo';
import { UiContext } from '../../ui';
import { TokensView } from './TokensView';

function renderTokens(
  agentId = 'main',
  open = demoOpen(),
  locale: 'en' | 'zh' = 'en',
  { kind = 'claude-code', quotas = [] }: { kind?: AgentKind; quotas?: QuotaSnapshot[] } = {},
) {
  const navigate = vi.fn();
  const setFollow = vi.fn();
  const store = createStore();
  store.applyEvent({ type: 'quota', quotas });
  render(
    <StoreContext.Provider value={store}>
      <SessionAgentContext.Provider value={kind}>
        <I18nContext.Provider value={makeI18n(locale)}>
          <UiContext.Provider value={{ follow: true, setFollow }}>
            <TokensView open={open} agentId={agentId} navigate={navigate} />
          </UiContext.Provider>
        </I18nContext.Provider>
      </SessionAgentContext.Provider>
    </StoreContext.Provider>,
  );
  return { navigate, setFollow };
}

const anthropic = (over: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  provider: 'anthropic',
  agent: 'claude-code',
  plan: 'Max',
  fetchedAt: new Date(Date.now() - 60_000).toISOString(),
  stale: false,
  windows: [
    {
      id: 'five_hour',
      kind: 'session',
      label: null,
      model: null,
      usedPercent: 62.4,
      resetsAt: null,
    },
    { id: 'seven_day', kind: 'weekly', label: null, model: null, usedPercent: 38, resetsAt: null },
  ],
  extraUsage: null,
  balance: null,
  source: 'claude-code-cache',
  ...over,
});

describe('TokensView', () => {
  it('leads with the conclusions', () => {
    renderTokens();
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(
      '84.1% of all tokens were cache reads: every request re-read a growing context.',
    );
    expect(note).toHaveTextContent('recon:prior-art spent 52.6% of all tokens.');
    // A lede, not an alert: the figures are set apart in mono, the words are not.
    expect([...note.querySelectorAll('.figure')].map((f) => f.textContent)).toEqual([
      '84.1%',
      '52.6%',
    ]);
  });

  it('places the plan’s window beside the session’s tokens, without adding them up', () => {
    renderTokens('main', demoOpen(), 'en', { quotas: [anthropic()] });
    expect(screen.getByRole('note')).toHaveTextContent(
      'Claude plan, 5-hour window: 62% used. This session’s tokens are a separate count.',
    );
  });

  it('dates a stale window, and speaks Chinese', () => {
    renderTokens('main', demoOpen(), 'zh', {
      quotas: [
        anthropic({ stale: true, fetchedAt: new Date(Date.now() - 3 * 3600_000).toISOString() }),
      ],
    });
    expect(screen.getByRole('note')).toHaveTextContent(
      /Claude 套餐 · 5 小时窗口：已用 62%（.+的数据）。本会话的 token 单独计数，不在其中。/,
    );
  });

  it('says nothing of a plan for an agent that can use any provider', () => {
    renderTokens('main', demoOpen(), 'en', { kind: 'opencode', quotas: [anthropic()] });
    expect(screen.getByRole('note')).not.toHaveTextContent(/plan/);
  });

  it('names the main agent in the UI language when it spent the most', () => {
    const open = demoOpen();
    const main = open.agents.get('main');
    if (!main) throw new Error('fixture');
    open.agents = new Map(open.agents).set('main', {
      ...main,
      usage: { ...main.usage, cacheRead: 50_000_000 },
    });
    renderTokens('main', open, 'zh');
    expect(screen.getByRole('note')).toHaveTextContent(/^.*主会话 花掉了全部 token 的/);
  });

  it('breaks the selected agent’s total into labelled buckets', () => {
    renderTokens();
    const totals = screen.getByRole('region', { name: 'Total' });
    expect(within(totals).getByText('1,880,890')).toBeInTheDocument();
    const legend = within(totals).getByRole('list');
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Cache read1,582,194',
      'Cache write256,500',
      'Uncached input156',
      'Output42,040',
      'of which thinking27,050',
    ]);
  });

  it('lists agents in tree order, or by spend, and opens one on click', () => {
    const { navigate } = renderTokens();
    const byAgent = screen.getByRole('region', { name: 'By sub-agent' });
    const labels = () =>
      within(byAgent)
        .getAllByRole('button', { name: /tokens$/ })
        .map((b) => b.querySelector('[data-label]')?.textContent);
    expect(labels()).toEqual([
      'Main',
      'Explore transcript format',
      'recon:live-write',
      'recon:prior-art',
      'verify:live-write',
    ]);
    expect(within(byAgent).getByText('cc-recon')).toBeInTheDocument();
    // The row's name says the agent's state, which its dot only shows.
    expect(
      within(byAgent).getByRole('button', { name: /^Main · Running · .+ tokens$/ }),
    ).toBeInTheDocument();
    fireEvent.click(within(byAgent).getByRole('radio', { name: 'By spend' }));
    expect(labels()).toEqual([
      'recon:prior-art',
      'recon:live-write',
      'Main',
      'Explore transcript format',
      'verify:live-write',
    ]);
    fireEvent.click(within(byAgent).getByRole('button', { name: /^recon:prior-art/ }));
    expect(navigate).toHaveBeenLastCalledWith({ agentId: 'af00000000000002' });
  });

  it('charts the selected agent’s context per request, with a data table', () => {
    renderTokens();
    const chart = screen.getByRole('region', { name: 'Context growth · Main' });
    expect(
      within(chart).getByRole('img', { name: 'Context size per request' }),
    ).toBeInTheDocument();
    const rows = within(chart).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Conversation 1 · call #131,250820',
      'Conversation 1 · call #234,9001,540',
      'Conversation 1 · call #337,800420',
      'Conversation 2 · call #152,4003,900',
      'Conversation 2 · call #256,500260',
    ]);
    const hits = chart.querySelectorAll('rect');
    fireEvent.mouseEnter(hits[3] as Element);
    expect(within(chart).getByRole('tooltip')).toHaveTextContent('Conversation 2 · call #1');
  });

  it('gives each chart point its own non-overlapping click area, so clicks land on the right request', () => {
    const open = demoOpen();
    const m1 = open.requests.get('req_m1');
    if (!m1) throw new Error('fixture');
    const many = new Map(open.requests);
    for (let i = 0; i < 120; i++)
      many.set(`dense_${i}`, {
        ...m1,
        id: `dense_${i}`,
        startedAt: new Date(Date.parse(m1.startedAt as string) + (i + 1) * 1000).toISOString(),
      });
    renderTokens('main', { ...open, requests: many });
    const chart = screen.getByRole('img', { name: 'Context size per request' });
    const hits = [...chart.querySelectorAll('rect')].map((r) => [
      Number(r.getAttribute('x')),
      Number(r.getAttribute('width')),
    ]);
    expect(hits.length).toBeGreaterThan(100);
    for (let i = 1; i < hits.length; i++) {
      const [x0, w0] = hits[i - 1] as [number, number];
      const [x1] = hits[i] as [number, number];
      expect(x0 + w0).toBeLessThanOrEqual(x1 + 0.001);
    }
  });

  it('ranks the costliest requests and jumps to one in the flow tab', () => {
    const { navigate, setFollow } = renderTokens();
    const top = screen.getByRole('region', { name: 'Costliest 5 requests' });
    const items = within(top).getAllByRole('button');
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent('recon:prior-art');
    expect(items[0]).toHaveTextContent('Conversation 1 · call #9');
    expect(items[0]).toHaveTextContent('193,900');
    fireEvent.click(items[0] as HTMLElement);
    expect(setFollow).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenLastCalledWith({
      tab: 'flow',
      agentId: 'af00000000000002',
      turnId: 'turn_w2',
      requestId: 'req_w2_9',
    });
  });

  it('scopes totals and the costliest list to a sub-agent', () => {
    renderTokens('a1b2c3d4e5f60718');
    const totals = screen.getByRole('region', { name: 'Total' });
    expect(within(totals).getByText('128,800')).toBeInTheDocument();
    const top = screen.getByRole('region', { name: 'Costliest 4 requests' });
    expect(within(top).getAllByRole('button')).toHaveLength(4);
  });
});
