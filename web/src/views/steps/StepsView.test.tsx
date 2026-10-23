import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionAgentContext } from '../../data/session-agent';
import type { OpenSession } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import type { Route } from '../../router';
import { DEMO_NOW, demoOpen } from '../../test/demo';
import { clampHeadings, useFakeLayout } from '../../test/layout';
import { UiContext } from '../../ui';
import { StepsView } from './StepsView';

function renderSteps(
  opts: { route?: Partial<Route>; follow?: boolean; agent?: string; open?: OpenSession } = {},
) {
  const navigate = vi.fn();
  const setFollow = vi.fn();
  const open = opts.open ?? demoOpen();
  const route: Route = {
    sessionId: open.id,
    agentId: 'main',
    tab: 'steps',
    turnId: null,
    requestId: null,
    ...opts.route,
  };
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <UiContext.Provider value={{ follow: opts.follow ?? true, setFollow }}>
        <SessionAgentContext.Provider value={opts.agent ?? 'claude-code'}>
          <StepsView open={open} agentId={route.agentId} route={route} navigate={navigate} />
        </SessionAgentContext.Provider>
      </UiContext.Provider>
    </I18nContext.Provider>,
  );
  return { navigate, setFollow };
}

const step = (n: number) => screen.getByRole('article', { name: `Step ${n}` });

describe('StepsView', () => {
  useFakeLayout();
  afterEach(() => vi.useRealTimers());

  it('lists the turns newest first, like the flow tab, with the followed turn on top', () => {
    renderSteps();
    const items = within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole(
      'button',
    );
    expect(items.map((b) => b.textContent?.match(/^Conversation \d+/)?.[0])).toEqual([
      'Conversation 3',
      'Conversation 2',
      'Conversation 1',
    ]);
    expect(items[0]).toHaveAttribute('aria-current', 'true');
  });

  it('offers “Back to latest” in the turn header while follow is paused', () => {
    const { navigate, setFollow } = renderSteps({ route: { turnId: 'turn_m1' }, follow: false });
    const back = screen.getByRole('button', { name: 'Back to latest' });
    expect(screen.getByRole('heading', { level: 2 }).parentElement?.parentElement).toContainElement(
      back,
    );
    fireEvent.click(back);
    expect(setFollow).toHaveBeenLastCalledWith(true);
    expect(navigate).toHaveBeenLastCalledWith({ turnId: null, requestId: null });
  });

  it('groups turn 1 into explore → edit → answer phases with time and tokens', () => {
    renderSteps({ route: { turnId: 'turn_m1' }, follow: false });
    const heads = screen.getAllByRole('heading', { level: 3 });
    expect(heads.map((h) => h.textContent)).toEqual(['Explore ×1', 'Edit ×1', 'Answer ×1']);
    const explore = heads[0]?.closest('[data-phase]') as HTMLElement;
    expect(within(explore).getByText('14s')).toBeInTheDocument();
    expect(within(explore).getByText('32,070 tokens')).toBeInTheDocument();
  });

  it('shows the share of time each phase took', () => {
    renderSteps({ route: { turnId: 'turn_m1' }, follow: false });
    const shares = screen.getByRole('list', { name: 'Phase shares' });
    expect(
      within(shares)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Explore 32%', 'Edit 48%', 'Answer 20%']);
  });

  it('tells each step as thought → said → did', () => {
    renderSteps({ route: { turnId: 'turn_m1' }, follow: false });
    const first = step(1);
    expect(first).toHaveTextContent(
      'Looking for where the session list is sorted before touching the UI.',
    );
    expect(first).toHaveTextContent('Let me look at how sessions are discovered first.');
    expect(within(first).getByText('rg -n "sortSessions" src')).toBeInTheDocument();
    expect(within(first).getByText('610 thinking tokens')).toBeInTheDocument();

    const second = step(2);
    expect(within(second).getByText('Thought for 12s; content not recorded')).toBeInTheDocument();
    const edit = within(second).getByText('Edit').closest('li') as HTMLElement;
    expect(edit).toHaveAttribute('data-status', 'error');
    expect(edit).toHaveTextContent('Failed');
  });

  it('badges failed and interrupted steps', () => {
    const open = demoOpen();
    const m1 = open.requests.get('req_m1');
    const m3 = open.requests.get('req_m3');
    if (!m1 || !m3) throw new Error('fixture');
    open.requests = new Map(open.requests)
      .set('req_m1', {
        ...m1,
        status: 'error',
        error: { message: 'overloaded', status: 529, retryAttempt: 3 },
      })
      .set('req_m3', { ...m3, status: 'interrupted' });
    const route: Route = {
      sessionId: open.id,
      agentId: 'main',
      tab: 'steps',
      turnId: 'turn_m1',
      requestId: null,
    };
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <UiContext.Provider value={{ follow: false, setFollow: vi.fn() }}>
          <StepsView open={open} agentId="main" route={route} navigate={vi.fn()} />
        </UiContext.Provider>
      </I18nContext.Provider>,
    );
    expect(within(step(1)).getByText('Failed')).toBeInTheDocument();
    expect(step(1)).toHaveTextContent('overloaded');
    expect(within(step(3)).getByText('Interrupted')).toBeInTheDocument();
    expect(step(3)).toHaveAttribute('data-outcome', 'interrupted');
    expect(within(step(2)).queryByText('Interrupted')).toBeNull();
  });

  it('says Codex thinking is encrypted rather than not recorded', () => {
    renderSteps({ route: { turnId: 'turn_m1' }, follow: false, agent: 'codex' });
    expect(
      within(step(2)).getByText('Thought for 12s; the content is encrypted'),
    ).toBeInTheDocument();
    // A step without any thinking block has nothing to decrypt.
    expect(within(step(1)).queryByText(/encrypted/)).toBeNull();
  });

  it('shows a dash with an explanation for steps whose start was not recorded', () => {
    const open = demoOpen();
    const m3 = open.requests.get('req_m3');
    if (!m3) throw new Error('fixture');
    open.requests = new Map(open.requests).set('req_m3', { ...m3, startedAt: m3.endedAt });
    const route: Route = {
      sessionId: open.id,
      agentId: 'main',
      tab: 'steps',
      turnId: 'turn_m1',
      requestId: null,
    };
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <UiContext.Provider value={{ follow: false, setFollow: vi.fn() }}>
          <StepsView open={open} agentId="main" route={route} navigate={vi.fn()} />
        </UiContext.Provider>
      </I18nContext.Provider>,
    );
    expect(
      within(step(3)).getByTitle(
        'This Claude Code version did not record when the request started',
      ),
    ).toHaveTextContent('—');
    expect(within(step(3)).queryByText('0ms')).toBeNull();
  });

  it('opens a step in the execution chain', () => {
    const { navigate, setFollow } = renderSteps({ route: { turnId: 'turn_m1' }, follow: false });
    fireEvent.click(within(step(2)).getByRole('button', { name: 'Show in execution chain' }));
    expect(setFollow).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenLastCalledWith({
      tab: 'flow',
      agentId: 'main',
      turnId: 'turn_m1',
      requestId: 'req_m2',
    });
  });

  it('follows the newest turn and ticks the step that is still thinking', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(DEMO_NOW);
    renderSteps();
    expect(within(step(1)).getByText('Thinking · 1:23')).toBeInTheDocument();
  });

  it('keeps the turn being read when follow is paused and a new turn arrives', () => {
    const full = demoOpen();
    const before: OpenSession = {
      ...full,
      turns: new Map([...full.turns].filter(([id]) => id !== 'turn_m3')),
    };
    const route: Route = {
      sessionId: full.id,
      agentId: 'main',
      tab: 'steps',
      turnId: null,
      requestId: null,
    };
    const tree = (open: OpenSession) => (
      <I18nContext.Provider value={makeI18n('en')}>
        <UiContext.Provider value={{ follow: false, setFollow: vi.fn() }}>
          <StepsView open={open} agentId="main" route={route} navigate={vi.fn()} />
        </UiContext.Provider>
      </I18nContext.Provider>
    );
    const { rerender } = render(tree(before));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/Conversation 2/);
    act(() => rerender(tree(full)));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/Conversation 2/);
  });

  it('follows the newest step as steps arrive, like the execution chain', () => {
    const full = demoOpen();
    const m1 = full.requests.get('req_m1');
    if (!m1) throw new Error('fixture');
    const route: Route = {
      sessionId: full.id,
      agentId: 'main',
      tab: 'steps',
      turnId: null,
      requestId: null,
    };
    const tree = (open: OpenSession, follow: boolean) => (
      <I18nContext.Provider value={makeI18n('en')}>
        <UiContext.Provider value={{ follow, setFollow: vi.fn() }}>
          <StepsView open={open} agentId="main" route={route} navigate={vi.fn()} />
        </UiContext.Provider>
      </I18nContext.Provider>
    );
    const { container, rerender } = render(tree(full, true));
    const scroller = container.querySelector('[data-steps-scroll]') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 5_000 });
    const more = (n: number): OpenSession => {
      const t3 = full.turns.get('turn_m3');
      if (!t3) throw new Error('fixture');
      const requests = new Map(full.requests);
      const ids = [...t3.requestIds];
      for (let i = 0; i < n; i++) {
        const id = `extra_${i}`;
        requests.set(id, { ...m1, id, turnId: 'turn_m3', index: 2 + i, toolCallIds: [] });
        ids.push(id);
      }
      return {
        ...full,
        requests,
        turns: new Map(full.turns).set('turn_m3', { ...t3, requestIds: ids }),
      };
    };
    act(() => rerender(tree(more(1), true)));
    expect(scroller.scrollTop).toBe(5_000);
    scroller.scrollTop = 100;
    act(() => rerender(tree(more(2), false)));
    expect(scroller.scrollTop).toBe(100);
  });

  it('pauses follow when the reader scrolls up in the steps', () => {
    const { setFollow } = renderSteps();
    const scroller = document.querySelector('[data-steps-scroll]') as HTMLElement;
    fireEvent.wheel(scroller, { deltaY: -120 });
    expect(setFollow).toHaveBeenCalledWith(false);
  });

  it('heads the turn with its whole prompt, expandable like the execution chain', () => {
    clampHeadings();
    renderSteps({ route: { turnId: 'turn_m2' }, follow: false });
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent(/Write the findings to notes\/research\.md, with sources\.$/);
    fireEvent.click(screen.getByRole('button', { name: 'Show full prompt' }));
    expect(heading).toHaveAttribute('data-expanded', 'true');
  });

  it('picks a turn from the turn list and pauses follow', () => {
    const { navigate, setFollow } = renderSteps();
    fireEvent.click(screen.getByRole('button', { name: /Conversation 2/ }));
    expect(setFollow).toHaveBeenLastCalledWith(false);
    expect(navigate).toHaveBeenLastCalledWith({ turnId: 'turn_m2', requestId: null });
  });
});
