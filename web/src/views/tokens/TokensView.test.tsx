import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentKind, QuotaSnapshot } from '../../../../src/core/model.js';
import { emptyUsage } from '../../../../src/core/usage.js';
import { SessionAgentContext } from '../../data/session-agent';
import { createStore, StoreContext } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import type { ContextPoint } from '../../lib/token-stats';
import { demoOpen } from '../../test/demo';
import { UiContext } from '../../ui';
import { ContextChart } from './ContextChart';
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
  it('says a sub-agent never seen to end ended unknown, not that it waits', () => {
    const open = demoOpen();
    const agent = open.agents.get('a1b2c3d4e5f60718');
    if (!agent) throw new Error('fixture');
    open.agents = new Map(open.agents).set(agent.id, { ...agent, status: 'unknown' });
    renderTokens('main', open);
    const row = screen.getByRole('button', { name: /^Explore transcript format · / });
    expect(row).toHaveAccessibleName(/^Explore transcript format · Ended \(unknown\) · /);
    expect(row).toHaveTextContent('Ended (unknown)');
    expect(row).not.toHaveTextContent('Waiting');
  });

  it('keeps every sub-agent’s tape wide enough to show its mix', () => {
    renderTokens();
    const rows = screen.getByRole('region', { name: 'By sub-agent' });
    const bars = [...rows.querySelectorAll<HTMLElement>('[style*="width"]')].filter((b) =>
      b.style.width.endsWith('%'),
    );
    expect(bars.length).toBeGreaterThan(3);
    for (const bar of bars) expect(bar.style.minWidth).toBe('24px');
  });

  it('says there is no token data, with “yet” only while the session runs', () => {
    const open = demoOpen();
    const agentId = 'a1b2c3d4e5f60718';
    const zero = emptyUsage();
    open.requests = new Map(
      [...open.requests].map(([id, r]) => [id, r.agentId === agentId ? { ...r, usage: zero } : r]),
    );
    open.agents = new Map(open.agents).set(agentId, {
      ...(open.agents.get(agentId) as NonNullable<ReturnType<typeof open.agents.get>>),
      status: 'complete',
      usage: zero,
    });
    renderTokens(agentId, open);
    expect(screen.getByText('No token data yet')).toBeInTheDocument();
    cleanup();
    renderTokens(agentId, { ...open, session: { ...open.session, live: 'closed' } });
    expect(screen.getByText('No token data for this agent')).toBeInTheDocument();
  });

  it('labels the tree / spend switch as the rows’ order', () => {
    renderTokens();
    expect(screen.getByRole('radiogroup', { name: 'Order' })).toBeInTheDocument();
  });

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
    // One sentence leads; the second takeaway is a line of its own under it.
    expect([...note.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      '84.1% of all tokens were cache reads: every request re-read a growing context.',
      'recon:prior-art spent 52.6% of all tokens.',
    ]);
  });

  it('places Grok’s sessions beside the xAI plan', () => {
    const xai: QuotaSnapshot = {
      ...anthropic(),
      provider: 'xai',
      agent: 'grok',
      plan: 'SuperGrok',
      windows: [
        {
          id: 'weekly',
          kind: 'weekly',
          label: 'SuperGrok Weekly Credits',
          model: null,
          usedPercent: 25,
          resetsAt: null,
        },
      ],
      source: 'xai-api',
    };
    renderTokens('main', demoOpen(), 'en', { kind: 'grok', quotas: [anthropic(), xai] });
    expect(screen.getByRole('note')).toHaveTextContent(
      'Grok plan, SuperGrok Weekly Credits: 25% used. This session’s tokens are a separate count.',
    );
    expect(screen.getByRole('note')).not.toHaveTextContent('Claude plan');
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
    expect(screen.getByRole('note')).toHaveTextContent(/^.*上下文。主会话 花掉了全部 token 的/);
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
      'Prompt 1 · call #131,250820',
      'Prompt 1 · call #234,9001,540',
      'Prompt 1 · call #337,800420',
      'Prompt 2 · call #152,4003,900',
      'Prompt 2 · call #256,500260',
    ]);
    const hits = chart.querySelectorAll('rect');
    fireEvent.mouseEnter(hits[3] as Element);
    expect(within(chart).getByRole('tooltip')).toHaveTextContent('Prompt 2 · call #1');
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
    expect(items[0]).toHaveTextContent('Prompt 1 · call #9');
    expect(items[0]).toHaveTextContent('193,900');
    fireEvent.click(items[0] as HTMLElement);
    expect(setFollow).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenLastCalledWith({
      tab: 'flow',
      agentId: 'af00000000000002',
      turnId: 'turn_w2',
      requestId: 'req_w2_9',
      card: 'request',
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

describe('ContextChart', () => {
  const point = (i: number): ContextPoint => ({
    requestId: `r${i}`,
    turn: 1,
    call: i + 1,
    at: null,
    context: 1_000 * (i + 1),
    output: 10,
    compacted: false,
  });
  const renderChart = (n: number) =>
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <ContextChart
          agent="Main"
          points={Array.from({ length: n }, (_, i) => point(i))}
          onPick={vi.fn()}
        />
      </I18nContext.Provider>,
    );

  // I3b F3: zh ticks read "2万"; the digits stay in the axis's mono face, the unit is set apart
  // in the UI face (CJK never in mono), rather than the whole axis leaving mono in zh.
  it('sets a Chinese tick’s unit apart from its digits', () => {
    const { container } = render(
      <I18nContext.Provider value={makeI18n('zh')}>
        <ContextChart
          agent="主会话"
          points={Array.from({ length: 30 }, (_, i) => point(i))}
          onPick={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    const ticks = [...container.querySelectorAll('text')].filter((t) =>
      /万/.test(t.textContent ?? ''),
    );
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      const own = [...tick.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join('');
      expect(own).toMatch(/^[\d.]+$/);
      expect(tick.querySelector('tspan')).toHaveTextContent(/^万$/);
    }
    const sheet = readFileSync(join(import.meta.dirname, 'TokensView.module.css'), 'utf8');
    expect(sheet).not.toMatch(/\.axis:lang\(zh\)/);
    expect(/\n\.axisUnit \{([^}]*)\}/.exec(sheet)?.[1]).toMatch(/font-family: var\(--font-ui\);/);
  });

  it('draws a dot per request while they are far enough apart', () => {
    const { container } = renderChart(12);
    expect(container.querySelectorAll('circle')).toHaveLength(12);
  });

  it('draws the line alone when dots would merge, keeping the last and the hovered point', () => {
    const { container } = renderChart(300);
    expect(container.querySelectorAll('path')).toHaveLength(1);
    expect(container.querySelectorAll('circle')).toHaveLength(1);
    fireEvent.mouseEnter(container.querySelectorAll('rect[class*="hit"]')[100] as Element);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });
});
