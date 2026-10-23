import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LivePartial } from '../../../../src/shared/runs.js';
import { SessionAgentContext } from '../../data/session-agent';
import type { OpenSession } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import type { Route } from '../../router';
import { DEMO_NOW, demoOpen } from '../../test/demo';
import { clampHeadings, useFakeLayout } from '../../test/layout';
import { UiContext } from '../../ui';
import { FlowView } from './FlowView';

const EXPLORE = 'a1b2c3d4e5f60718';

function renderFlow(
  opts: { route?: Partial<Route>; follow?: boolean; open?: OpenSession; live?: LivePartial } = {},
) {
  const navigate = vi.fn();
  const setFollow = vi.fn();
  const open = opts.open ?? demoOpen();
  const route: Route = {
    sessionId: open.id,
    agentId: 'main',
    tab: 'flow',
    turnId: null,
    requestId: null,
    ...opts.route,
  };
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <UiContext.Provider value={{ follow: opts.follow ?? true, setFollow }}>
        <FlowView
          open={open}
          agentId={route.agentId}
          route={route}
          navigate={navigate}
          live={opts.live ?? null}
        />
      </UiContext.Provider>
    </I18nContext.Provider>,
  );
  return { navigate, setFollow };
}

const row = (n: number) => screen.getByRole('article', { name: `Model call #${n}` });

function flowTree(
  open: OpenSession,
  follow: boolean,
  setFollow = vi.fn(),
  turnId: string | null = null,
): ReactNode {
  const route: Route = {
    sessionId: open.id,
    agentId: 'main',
    tab: 'flow',
    turnId,
    requestId: null,
  };
  return (
    <I18nContext.Provider value={makeI18n('en')}>
      <UiContext.Provider value={{ follow, setFollow }}>
        <FlowView open={open} agentId="main" route={route} navigate={vi.fn()} />
      </UiContext.Provider>
    </I18nContext.Provider>
  );
}

/** The demo session before turn 3's first request has arrived. */
function withoutTurn3Requests(): OpenSession {
  const full = demoOpen();
  const t3 = full.turns.get('turn_m3');
  if (!t3) throw new Error('fixture');
  return {
    ...full,
    requests: new Map([...full.requests].filter(([, r]) => r.turnId !== 'turn_m3')),
    turns: new Map(full.turns).set('turn_m3', { ...t3, requestIds: [] }),
  };
}

/** The demo session with one turn's prompt replaced. */
function withPrompt(turnId: string, prompt: string): OpenSession {
  const open = demoOpen();
  const turn = open.turns.get(turnId);
  if (!turn) throw new Error('fixture');
  open.turns = new Map(open.turns).set(turnId, { ...turn, prompt });
  return open;
}

/** The demo session with a /effort turn before the first prompt (no model call followed). */
function withLocalCommand(): OpenSession {
  const open = demoOpen();
  const first = open.turns.get('turn_m1');
  if (!first) throw new Error('fixture');
  open.turns = new Map([
    [
      'turn_cmd',
      {
        ...first,
        id: 'turn_cmd',
        index: 1,
        prompt: '/effort',
        startedAt: '2026-10-23T00:00:00.000Z',
        endedAt: '2026-10-23T00:00:00.000Z',
        requestIds: [],
      },
    ],
    ...open.turns,
  ]);
  return open;
}

const callScroller = (container: HTMLElement) =>
  container.querySelector('[data-index]')?.parentElement?.parentElement as HTMLElement;

describe('FlowView', () => {
  useFakeLayout();
  afterEach(() => vi.useRealTimers());

  it('says “yet” of an empty conversation or agent only while more may still arrive', () => {
    const base = demoOpen();
    const first = [...base.turns.values()][0];
    if (!first) throw new Error('fixture');
    const emptyTurn = (status: 'running' | 'complete'): OpenSession => ({
      ...base,
      turns: new Map(base.turns).set(first.id, { ...first, requestIds: [], status }),
      requests: new Map([...base.requests].filter(([, r]) => r.turnId !== first.id)),
    });
    renderFlow({ open: emptyTurn('complete'), route: { turnId: first.id }, follow: false });
    expect(screen.getByText('No model calls in this conversation')).toBeInTheDocument();
    cleanup();
    renderFlow({ open: emptyTurn('running'), route: { turnId: first.id }, follow: false });
    expect(screen.getByText('No model calls in this conversation yet')).toBeInTheDocument();
    cleanup();

    // An agent with no turns: "yet" only while the session runs.
    renderFlow({
      open: { ...base, session: { ...base.session, live: 'closed' } },
      route: { agentId: 'nobody' },
    });
    expect(screen.getByText('No conversations for this agent')).toBeInTheDocument();
    cleanup();
    renderFlow({
      open: { ...base, session: { ...base.session, live: 'busy' } },
      route: { agentId: 'nobody' },
    });
    expect(screen.getByText('No conversations for this agent yet')).toBeInTheDocument();
  });

  it('lists the agent’s turns newest first and follows the newest, on top', () => {
    renderFlow();
    const turns = screen.getByRole('list', { name: 'Conversations' });
    // DOM order is display order, so Tab walks the turns as they are seen.
    const items = within(turns).getAllByRole('button');
    expect(items.map((b) => b.querySelector('[data-title]')?.textContent)).toEqual([
      'Conversation 3: Now write the design document from the findings',
      expect.stringMatching(
        /^Conversation 2: Research how a live viewer could read Claude Code transcripts, use ultracode\. What I need to know: - .+…$/,
      ),
      'Conversation 1: Busy sessions should be listed first in the sidebar',
    ]);
    expect(items[0]).toHaveAttribute('aria-current', 'true');
    expect(within(items[0] as HTMLElement).getByText('Running')).toBeInTheDocument();
    expect(
      within(items[2] as HTMLElement).getByText('3 model calls · 3 tools'),
    ).toBeInTheDocument();
    expect(within(items[2] as HTMLElement).getByText('Complete')).toBeInTheDocument();
  });

  it('keeps an older turn picked from the URL selected while newer ones stay on top', () => {
    renderFlow({ route: { turnId: 'turn_m1' }, follow: false });
    const items = within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole(
      'button',
    );
    expect(items[2]).toHaveAttribute('aria-current', 'true');
    expect(items[2]).toHaveTextContent('Conversation 1');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Conversation 1: /);
  });

  it('lists a local slash command compactly, and a prompt like it with calls in full', () => {
    renderFlow({ open: withLocalCommand() });
    const card = screen.getByRole('button', { name: /\/effort/ });
    expect(card).toHaveAttribute('data-command');
    expect(within(card).getByText('local command')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Busy sessions should be listed/ }),
    ).not.toHaveAttribute('data-command');
  });

  it('lists the same turn in full in another agent’s session', () => {
    const open = withLocalCommand();
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionAgentContext.Provider value="codex">
          <UiContext.Provider value={{ follow: true, setFollow: vi.fn() }}>
            <FlowView
              open={open}
              agentId="main"
              route={{
                sessionId: open.id,
                agentId: 'main',
                tab: 'flow',
                turnId: null,
                requestId: null,
              }}
              navigate={vi.fn()}
            />
          </UiContext.Provider>
        </SessionAgentContext.Provider>
      </I18nContext.Provider>,
    );
    expect(screen.getByRole('button', { name: /\/effort/ })).not.toHaveAttribute('data-command');
  });

  it('keeps a pasted 5 KB prompt to 120 characters in the list, all of it on hover', () => {
    const prompt = `Paste: ${'log line '.repeat(600)}`;
    renderFlow({ open: withPrompt('turn_m1', prompt) });
    const card = screen.getByRole('button', { name: /Conversation 1/ });
    const title = card.querySelector('[data-title]')?.textContent ?? '';
    expect([...title]).toHaveLength('Conversation 1: '.length + 120 + 1);
    expect(title.endsWith('…')).toBe(true);
    expect(card).toHaveAttribute('title', prompt);
  });

  it('heads the open turn with its whole prompt, with no toggle when it fits', () => {
    const prompt = 'Now write the design document from the findings. '.repeat(8).trim();
    renderFlow({ open: withPrompt('turn_m3', prompt) });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      `Conversation 3: ${prompt}`,
    );
    expect(screen.queryByRole('button', { name: 'Show full prompt' })).toBeNull();
  });

  it('lets a prompt longer than the heading be read in full, line breaks kept', () => {
    clampHeadings();
    const prompt =
      'Fix the sidebar.\n\nSteps:\n- sort busy sessions first\n- keep the rest by recency';
    renderFlow({ open: withPrompt('turn_m3', prompt) });
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveAttribute('data-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Show full prompt' }));
    expect(heading).toHaveAttribute('data-expanded', 'true');
    expect(heading.textContent).toBe(`Conversation 3: ${prompt}`);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('keeps the prompt open while its turn updates, and folds it on a turn change', () => {
    clampHeadings();
    const open = demoOpen();
    const { rerender } = render(flowTree(open, false, vi.fn(), 'turn_m3'));
    fireEvent.click(screen.getByRole('button', { name: 'Show full prompt' }));
    act(() => rerender(flowTree({ ...open }, false, vi.fn(), 'turn_m3')));
    expect(screen.getByRole('heading', { level: 2 })).toHaveAttribute('data-expanded', 'true');
    act(() => rerender(flowTree(open, false, vi.fn(), 'turn_m1')));
    expect(screen.getByRole('heading', { level: 2 })).toHaveAttribute('data-expanded', 'false');
    act(() => rerender(flowTree(open, false, vi.fn(), 'turn_m3')));
    expect(screen.getByRole('heading', { level: 2 })).toHaveAttribute('data-expanded', 'false');
  });

  it('says who sent a turn that did not come from the person', () => {
    const open = demoOpen();
    const t2 = open.turns.get('turn_m2');
    if (!t2) throw new Error('fixture');
    open.turns = new Map(open.turns).set('turn_m2', {
      ...t2,
      origin: 'peer',
      sender: 'glassbox-7a',
    });
    renderFlow({ open });
    const card = screen.getByRole('button', { name: /Conversation 2/ });
    expect(card).toHaveTextContent('from glassbox-7a');
    expect(screen.getByRole('button', { name: /Conversation 1/ })).not.toHaveTextContent('from');
  });

  it('lists calls that belong to no turn under “Calls outside conversations”', () => {
    const open = demoOpen();
    const m1 = open.requests.get('req_m1');
    if (!m1) throw new Error('fixture');
    open.requests = new Map(open.requests).set('orph', {
      ...m1,
      id: 'orph',
      turnId: null,
      startedAt: new Date(Date.parse(m1.startedAt as string) - 60_000).toISOString(),
      toolCallIds: [],
    });
    const { navigate } = renderFlow({ open, follow: false });
    const card = screen.getByRole('button', { name: /Calls outside conversations/ });
    expect(card).toHaveTextContent('1 model call · 0 tools');
    fireEvent.click(card);
    expect(navigate).toHaveBeenLastCalledWith({ turnId: 'outside:main', requestId: null });
  });

  it('shows a dash, not 0ms, for a request whose start was not recorded', () => {
    const open = demoOpen();
    const m1 = open.requests.get('req_m1');
    if (!m1) throw new Error('fixture');
    open.requests = new Map(open.requests).set('req_m1', { ...m1, startedAt: m1.endedAt });
    renderFlow({ open, route: { turnId: 'turn_m1' }, follow: false });
    const dash = within(row(1)).getByTitle(
      'This Claude Code version did not record when the request started',
    );
    expect(dash).toHaveTextContent('—');
    expect(within(row(1)).queryByText('0ms')).toBeNull();
  });

  it('ticks the in-flight request timer every second', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(DEMO_NOW);
    renderFlow();
    const call = row(1);
    expect(within(call).getByText('Thinking · 1:23')).toBeInTheDocument();
    expect(within(call).getAllByText('claude-opus-5-5').length).toBeGreaterThan(0);
    expect(within(call).getAllByText('max').length).toBeGreaterThan(0);
    act(() => vi.advanceTimersByTime(1000));
    expect(within(call).getByText('Thinking · 1:24')).toBeInTheDocument();
  });

  it('shows token headers, the failed Edit and the final reply in turn 1', () => {
    renderFlow({ route: { turnId: 'turn_m1' }, follow: false });
    const first = row(1);
    expect(within(first).getByText('Input 31,250')).toBeInTheDocument();
    expect(within(first).getByText('Uncached 6')).toBeInTheDocument();
    expect(within(first).getByText('Cache hit 244')).toBeInTheDocument();
    expect(within(first).getByText('Cache write 31,000')).toBeInTheDocument();
    expect(within(first).getByText('Output 820 (thinking 610)')).toBeInTheDocument();
    expect(within(first).getByText('14s')).toBeInTheDocument();

    const second = row(2);
    expect(
      within(second).getByText('Failed', { selector: '[data-status-label]' }),
    ).toBeInTheDocument();
    const edit = within(second).getByRole('button', { name: /^Edit/ });
    expect(edit).toHaveTextContent('Failed');
    expect(within(second).getAllByText('Failed').length).toBeGreaterThanOrEqual(2);

    expect(within(row(3)).getByText('Final reply')).toBeInTheDocument();
  });

  it('shows spawned agents on Agent and Workflow cards and opens them', () => {
    const { navigate } = renderFlow({ route: { turnId: 'turn_m2' }, follow: false });
    const call = row(1);
    const agentCard = within(call).getByRole('group', { name: 'Agent' });
    expect(agentCard).toHaveTextContent('Explore transcript format');
    expect(agentCard).toHaveTextContent('Complete');
    fireEvent.click(within(agentCard).getByRole('button', { name: /^Explore transcript format/ }));
    expect(navigate).toHaveBeenLastCalledWith({ agentId: EXPLORE, turnId: null, requestId: null });

    const wfCard = within(call).getByRole('group', { name: 'Workflow' });
    expect(wfCard).toHaveTextContent('cc-recon');
    expect(within(wfCard).getByText('Recon 1/2')).toBeInTheDocument();
    expect(within(wfCard).getByText('Verify 0/1')).toBeInTheDocument();
    fireEvent.click(within(wfCard).getByRole('button', { name: /^recon:prior-art/ }));
    expect(navigate).toHaveBeenLastCalledWith({
      agentId: 'af00000000000002',
      turnId: null,
      requestId: null,
    });
  });

  it('shows the cumulative tokens of a spawned agent, including its own sub-agents', () => {
    const open = demoOpen();
    const explore = open.agents.get(EXPLORE);
    if (!explore) throw new Error('fixture');
    open.agents = new Map(open.agents).set('child', {
      ...explore,
      id: 'child',
      parentId: EXPLORE,
      label: 'nested helper',
      usage: { ...explore.usage, cacheRead: 1_000_000, input: 0, cacheWrite: 0, output: 0 },
    });
    renderFlow({ open, route: { turnId: 'turn_m2' }, follow: false });
    const card = within(row(1)).getByRole('group', { name: 'Agent' });
    // 128,800 own + 1,000,000 from the nested agent.
    expect(card).toHaveTextContent('1.1M');
  });

  it('does not make screen readers announce a running timer every second', () => {
    renderFlow({ route: { agentId: 'af00000000000002' } });
    const bash = within(row(9)).getByRole('button', { name: /^Run\s*Bash/ });
    for (const live of bash.querySelectorAll('[aria-live]'))
      expect(live.textContent).not.toMatch(/\d:\d\d/);
  });

  it('shows a running tool with its own ticking timer', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(DEMO_NOW);
    renderFlow({ route: { agentId: 'af00000000000002' } });
    const bash = within(row(9)).getByRole('button', { name: /^Run\s*Bash/ });
    expect(bash).toHaveTextContent('Running · 26:22');
  });

  it('opens one detail panel at a time inside the row of the clicked card', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    renderFlow({ route: { turnId: 'turn_m1' }, follow: false });
    fireEvent.click(within(row(1)).getByRole('button', { name: /^Response/ }));
    expect(within(row(1)).getByRole('region', { name: 'Response details' })).toBeInTheDocument();
    fireEvent.click(within(row(2)).getByRole('button', { name: /^Edit/ }));
    expect(within(row(1)).queryByRole('region')).toBeNull();
    expect(within(row(2)).getByRole('region', { name: 'Tool call details' })).toBeInTheDocument();
    fireEvent.click(within(row(2)).getByRole('button', { name: /^Edit/ }));
    expect(screen.queryByRole('region', { name: /details/ })).toBeNull();
    vi.unstubAllGlobals();
  });

  it('pauses follow on scrolling up in a turn that had no calls when it appeared', () => {
    const setFollow = vi.fn();
    const { container, rerender } = render(flowTree(withoutTurn3Requests(), true, setFollow));
    expect(container.querySelector('[data-index]')).toBeNull();
    act(() => rerender(flowTree(demoOpen(), true, setFollow)));
    fireEvent.wheel(callScroller(container), { deltaY: -100 });
    expect(setFollow).toHaveBeenCalledWith(false);
  });

  it('keeps the turn being read when follow is paused and a new turn arrives', () => {
    const full = demoOpen();
    const before: OpenSession = {
      ...full,
      turns: new Map([...full.turns].filter(([id]) => id !== 'turn_m3')),
    };
    const { rerender } = render(flowTree(before, false));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/Conversation 2/);
    act(() => rerender(flowTree(full, false)));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/Conversation 2/);
  });

  it('pauses follow when a card is opened, so new calls do not scroll it away', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    const { setFollow } = renderFlow();
    fireEvent.click(within(row(1)).getByRole('button', { name: /^Request/ }));
    expect(setFollow).toHaveBeenCalledWith(false);
    vi.unstubAllGlobals();
  });

  it('streams a glassbox run’s reply under the newest turn only', () => {
    const live: LivePartial = {
      messageId: 'm',
      startedAt: DEMO_NOW.toISOString(),
      thinking: '',
      thinkingTokens: null,
      text: 'Streaming answer',
      toolUses: [],
    };
    renderFlow({ live });
    expect(screen.getByRole('status', { name: 'Replying live' })).toHaveTextContent(
      'Streaming answer',
    );
    cleanup();
    renderFlow({ live, route: { turnId: 'turn_m1' }, follow: false });
    expect(screen.queryByRole('status', { name: 'Replying live' })).toBeNull();
  });

  it('pauses follow when a turn is picked, and resumes from “Back to latest”', () => {
    const { navigate, setFollow } = renderFlow();
    expect(screen.queryByRole('button', { name: 'Back to latest' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Conversation 1/ }));
    expect(setFollow).toHaveBeenLastCalledWith(false);
    expect(navigate).toHaveBeenLastCalledWith({ turnId: 'turn_m1', requestId: null });
  });

  it('offers “Back to latest” in the turn header while follow is paused', () => {
    const { navigate, setFollow } = renderFlow({ route: { turnId: 'turn_m1' }, follow: false });
    const back = screen.getByRole('button', { name: 'Back to latest' });
    // In the header row, beside the turn's meta, not floating over the calls.
    expect(screen.getByRole('heading', { level: 2 }).parentElement?.parentElement).toContainElement(
      back,
    );
    fireEvent.click(back);
    expect(setFollow).toHaveBeenLastCalledWith(true);
    expect(navigate).toHaveBeenLastCalledWith({ turnId: null, requestId: null });
  });

  it('opens the turn of a linked request and highlights its row', () => {
    renderFlow({ route: { requestId: 'req_m2' }, follow: false });
    expect(screen.getByRole('button', { name: /Conversation 1/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(row(2)).toHaveAttribute('data-focused', 'true');
    expect(row(1)).not.toHaveAttribute('data-focused');
  });

  it('renders a request whose turn has not arrived without throwing', () => {
    const open = demoOpen();
    const orphan = { ...(open.requests.get('req_m1') as never as object), id: 'r_orphan' };
    open.requests = new Map(open.requests).set('r_orphan', {
      ...(orphan as ReturnType<typeof open.requests.get> & object),
      turnId: 'turn_missing',
    });
    expect(() => renderFlow({ open })).not.toThrow();
  });
});
