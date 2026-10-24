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
import { moduleCssValue } from '../../test/module-css';
import { UiContext } from '../../ui';
import { FlowView } from './FlowView';
import css from './FlowView.module.css';
import headerCss from './TurnHeader.module.css';

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
  it('gives the turn list a fixed column, so the calls keep the width for their cards', () => {
    renderFlow({ route: { turnId: 'turn_m1' } });
    const flow = document.querySelector(`.${css.flow}`) as HTMLElement;
    const sheet = `${import.meta.dirname}/FlowView.module.css`;
    // The board's list is 248 of a 1,180 px panel; under a 1,000 px panel it is 200 px (a rule
    // in a container query, which the matcher leaves out).
    expect(moduleCssValue(sheet, css, flow, 'grid-template-columns')).toBe(
      'minmax(240px, 264px) minmax(0, 1fr)',
    );
  });

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
    // The number column says which conversation; the title is the prompt alone.
    expect(items.map((b) => b.querySelector('[data-title]')?.textContent)).toEqual([
      'Now write the design document from the findings',
      expect.stringMatching(
        /^Research how a live viewer could read Claude Code transcripts, use ultracode\. What I need to know: - .+…$/,
      ),
      'Busy sessions should be listed first in the sidebar',
    ]);
    expect(items.map((b) => b.textContent?.match(/^Conversation \d/)?.[0])).toEqual([
      'Conversation 3',
      'Conversation 2',
      'Conversation 1',
    ]);
    expect(items[0]).toHaveAttribute('aria-current', 'true');
    expect(within(items[0] as HTMLElement).getAllByText('Running')[0]).toBeInTheDocument();
    expect(items[2]).toHaveTextContent('3 calls · 3 tools');
    // A complete turn is a quiet check, named for screen readers.
    expect(
      within(items[2] as HTMLElement).getAllByRole('img', { name: 'Complete' })[0],
    ).toBeInTheDocument();
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

  it('labels work resumed after a usage limit, its calls counted as usual', () => {
    const open = demoOpen();
    open.turns = new Map(
      [...open.turns].map(([id, turn]) => [
        id,
        id === 'turn_m1'
          ? {
              ...turn,
              origin: 'auto-continuation' as const,
              prompt:
                'Your claude.ai usage limit has reset. Continue the task you were working on…',
            }
          : turn,
      ]),
    );
    renderFlow({ open });
    const card = screen.getByRole('button', {
      // W2's rows: the hidden label, then the title (no colon; jsdom drops the space between).
      name: /^Conversation 1\s*Continued after usage limit/,
    });
    expect(card).not.toHaveTextContent(/usage limit has reset/);
    expect(card).not.toHaveAttribute('data-command');
    // W2's rows count "3 calls · 3 tools", the figures in their own spans.
    expect(card).toHaveTextContent(/\d+ calls? · \d+ tools?/);
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
    expect([...title]).toHaveLength(120 + 1);
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
    expect(card).toHaveTextContent('1 call · 0 tools');
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
    // The why line and the Response card, which say nothing yet, both count the thinking.
    const why = call.querySelector('p') as HTMLElement;
    const response = within(call).getByRole('group', { name: 'Response' });
    expect(why).toHaveTextContent('Thinking · 1:23');
    expect(response).toHaveTextContent('Thinking · 1:23');
    expect(within(call).getAllByText('claude-opus-5-5').length).toBeGreaterThan(0);
    expect(within(call).getAllByText('max').length).toBeGreaterThan(0);
    act(() => vi.advanceTimersByTime(1000));
    expect(why).toHaveTextContent('Thinking · 1:24');
    expect(response).toHaveTextContent('Thinking · 1:24');
  });

  it('shows token headers, the failed Edit and the final reply in turn 1', () => {
    renderFlow({ route: { turnId: 'turn_m1' }, follow: false });
    const first = row(1);
    // One line of readings: the words muted, the figures mono.
    expect(within(first).getByRole('heading', { level: 3 })).toHaveTextContent('#1');
    expect(within(first).getByRole('heading', { level: 3 })).toHaveAccessibleName('Model call #1');
    const line = within(first).getByText('in').parentElement?.parentElement as HTMLElement;
    expect(line).toHaveTextContent(
      'in 31,250uncached 6cache hit 244cache write 31,000out 820 (610 thinking)',
    );
    expect(within(first).getByText('31,250')).toHaveClass('figure');
    expect(within(first).getByText('14s')).toHaveClass('figure');

    const second = row(2);
    // The call's mark, and the Edit card's result line.
    expect(within(second).getAllByText('Failed', { selector: '[data-status-label]' })).toHaveLength(
      2,
    );
    const edit = within(second).getByRole('button', { name: /^Edit/ });
    expect(within(edit).getByText('Failed', { selector: '[data-status-label]' })).toBeVisible();

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
    expect(card).toHaveTextContent('1.13M');
  });

  it('does not make screen readers announce a running timer every second', () => {
    renderFlow({ route: { agentId: 'af00000000000002' } });
    const bash = within(row(9)).getByRole('button', { name: /^Bash/ });
    for (const live of bash.querySelectorAll('[aria-live]'))
      expect(live.textContent).not.toMatch(/\d:\d\d/);
  });

  it('shows a running tool with its own ticking timer', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(DEMO_NOW);
    renderFlow({ route: { agentId: 'af00000000000002' } });
    const bash = within(row(9)).getByRole('button', { name: /^Bash/ });
    // W1's running mark and word, then the clock in mono where a finished call has its duration.
    expect(within(bash).getByText('Running', { selector: '[data-status-label]' })).toBeVisible();
    expect(within(bash).getByText('26:22')).toHaveClass('figure');
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

  it('says following is paused, in a bar under the turn header, with the way back', () => {
    const { navigate, setFollow } = renderFlow({ route: { turnId: 'turn_m1' }, follow: false });
    // In the layout between the header and the calls, not floating over them.
    const header = screen.getByRole('heading', { level: 2 }).closest(`.${headerCss.header}`);
    const bar = header?.nextElementSibling;
    if (!(bar instanceof HTMLElement)) throw new Error('no bar after the header');
    // The newest conversation (3) is still running in the demo.
    expect(within(bar).getByRole('status')).toHaveTextContent(
      'Following paused · Conversation 3 is running',
    );
    const back = within(bar).getByRole('button', { name: 'Back to latest' });
    fireEvent.click(back);
    expect(setFollow).toHaveBeenLastCalledWith(true);
    expect(navigate).toHaveBeenLastCalledWith({ turnId: null, requestId: null });
  });

  it('puts the open card in the URL, so a tool call is a link, and clears it on close', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    const { navigate, setFollow } = renderFlow({ route: { turnId: 'turn_m1' }, follow: false });
    fireEvent.click(within(row(2)).getByRole('button', { name: /^Edit/ }));
    expect(navigate).toHaveBeenLastCalledWith(
      { turnId: 'turn_m1', requestId: 'req_m2', card: 'tool:tu_m2b' },
      { replace: true },
    );
    expect(setFollow).toHaveBeenCalledWith(false);
    // A clicked call is where the reader is: not marked like a linked one.
    expect(row(2)).not.toHaveAttribute('data-focused');
    fireEvent.click(within(row(2)).getByRole('button', { name: /^Edit/ }));
    expect(navigate).toHaveBeenLastCalledWith(
      { requestId: null, card: undefined },
      { replace: true },
    );
    vi.unstubAllGlobals();
  });

  it('opens the card a link names, in its call', () => {
    renderFlow({
      route: { turnId: 'turn_m1', requestId: 'req_m2', card: 'tool:tu_m2b' },
      follow: false,
    });
    expect(within(row(2)).getByRole('region', { name: 'Tool call details' })).toBeInTheDocument();
    expect(row(2)).toHaveAttribute('data-focused');
  });

  it('opens the call but no panel for a card it no longer has', () => {
    renderFlow({
      route: { turnId: 'turn_m1', requestId: 'req_m2', card: 'tool:gone' },
      follow: false,
    });
    expect(row(2)).toHaveAttribute('data-focused');
    expect(screen.queryByRole('region', { name: /details/ })).toBeNull();
  });

  it('follows the newest conversation that passes the filter, and keeps the stage when none does', () => {
    renderFlow();
    const field = screen.getByRole('searchbox', { name: 'Filter conversations' });
    fireEvent.change(field, { target: { value: 'busy sessions' } });
    const list = screen.getByRole('list', { name: 'Conversations' });
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Conversation 1: Busy/);
    fireEvent.change(field, { target: { value: 'busy sessionsx' } });
    expect(screen.getByText('No conversation matches')).toBeInTheDocument();
    // Nothing in the list to follow: the conversation on stage stays, rather than the newest
    // one the filter has just ruled out.
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Conversation 1: Busy/);
    fireEvent.change(field, { target: { value: '' } });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Conversation 3: /);
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
