import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createDemoQuota,
  createDemoSessions,
  createDemoSnapshot,
  DEMO_SESSION_ID,
} from '../../src/core/fixtures/demo.js';
import type { RunState } from '../../src/shared/runs.js';
import { App, sidebarMode } from './App';
import type { RunsClient } from './data/runs';
import { createStore } from './data/store';
import { DEMO_NOW, demoStore } from './test/demo';
import { useFakeLayout } from './test/layout';

const noConnect = () => () => {};
const sidebar = () => screen.getByRole('navigation', { name: 'Sessions' });

function fakeRuns(over: Partial<RunsClient> = {}): RunsClient {
  return {
    token: vi.fn(async () => 't'),
    start: vi.fn(async () => runState({ id: 'run_new', sessionId: null, status: 'starting' })),
    send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    decide: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    directories: vi.fn(async () => ['/w/demo']),
    ...over,
  };
}

function runState(over: Partial<RunState>): RunState {
  return {
    id: 'run_1',
    sessionId: DEMO_SESSION_ID,
    cwd: '/w/demo',
    mode: 'fork',
    status: 'idle',
    permissionMode: 'default',
    startedAt: DEMO_NOW.toISOString(),
    updatedAt: DEMO_NOW.toISOString(),
    pendingPermissions: [],
    partial: null,
    error: null,
    last: null,
    ...over,
  };
}

describe('App', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEMO_NOW);
    window.location.hash = '';
  });
  afterEach(() => {
    vi.useRealTimers();
    window.location.hash = '';
  });

  it('shows the session list and an empty state on the home route', () => {
    const store = createStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    render(<App store={store} connect={noConnect} />);
    expect(screen.getByRole('heading', { name: 'Pick a session' })).toBeInTheDocument();
    expect(within(sidebar()).getAllByRole('list')).toHaveLength(3);
    // No session open: the header names no agent.
    expect(within(screen.getByRole('banner')).queryByText('Claude Code')).toBeNull();
  });

  it('does not claim there are no sessions before the list has arrived', () => {
    render(<App store={createStore()} connect={noConnect} runs={fakeRuns()} />);
    expect(screen.queryByText(/No sessions yet/)).toBeNull();
  });

  it('welcomes a first-time user: what glassbox reads and how to start', () => {
    const store = createStore();
    store.applyEvent({ type: 'sessions', sessions: [] });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    expect(screen.getByRole('heading', { name: 'No sessions yet' })).toBeInTheDocument();
    // Every agent glassbox reads, where from, and how to change it.
    for (const s of ['~/.claude/projects', '--claude-dir', '~/.grok', '--grok-dir', '--no-grok'])
      expect(screen.getByRole('main')).toHaveTextContent(s);
    expect(screen.getByRole('main')).toHaveTextContent('read-only');
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'New session' }));
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeInTheDocument();
  });

  it('puts running sessions first on the home screen and opens the most active one', async () => {
    const store = createStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    const running = screen.getByRole('region', { name: 'Running now' });
    const card = within(running).getByRole('button', { name: /Live viewer research/ });
    expect(within(card).getByText('Claude Code')).toHaveAttribute('data-agent', 'claude-code');
    expect(within(running).queryByRole('button', { name: /Fix flaky login/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open the most recently active session' }));
    await waitFor(() =>
      expect(window.location.hash).toBe(`#/s/${encodeURIComponent(DEMO_SESSION_ID)}`),
    );
  });

  it('offers recent sessions when nothing is running', async () => {
    const store = createStore();
    const [, idle, closed] = createDemoSessions(DEMO_NOW);
    if (!idle || !closed) throw new Error('fixture');
    store.applyEvent({ type: 'sessions', sessions: [closed, idle] });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    expect(screen.queryByRole('region', { name: 'Running now' })).toBeNull();
    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(
      within(recent)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      expect.stringContaining('Fix flaky login test'),
      expect.stringContaining('Untitled session'),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Open the most recently active session' }));
    await waitFor(() => expect(window.location.hash).toBe(`#/s/${encodeURIComponent(idle.id)}`));
  });

  it('opens a session when it is clicked in the sidebar', async () => {
    const store = createStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    const connect = vi.fn(noConnect);
    render(<App store={store} connect={connect} />);
    fireEvent.click(within(sidebar()).getByRole('button', { name: /Live viewer research/ }));
    expect(window.location.hash).toBe(`#/s/${encodeURIComponent(DEMO_SESSION_ID)}`);
    // Browsers (and jsdom) deliver hashchange asynchronously.
    await waitFor(() => expect(store.getState().openId).toBe(DEMO_SESSION_ID));
    expect(connect).toHaveBeenLastCalledWith(store, DEMO_SESSION_ID);
  });

  it('offers a skip link as the first stop, which moves focus to the content', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    render(<App store={demoStore()} connect={noConnect} />);
    const skip = screen.getByRole('button', { name: 'Skip to main content' });
    const focusable = document.querySelectorAll('button, [href], input, [tabindex="0"]');
    expect(focusable[0]).toBe(skip);
    fireEvent.click(skip);
    expect(document.activeElement).toBe(screen.getByRole('main'));
    expect(window.location.hash).toBe(`#/s/${encodeURIComponent(DEMO_SESSION_ID)}`);
  });

  it('starts follow afresh when another session opens', async () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    const store = createStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    render(<App store={store} connect={noConnect} />);
    const follow = () => within(screen.getByRole('banner')).getByRole('button', { name: /Follow/ });
    fireEvent.click(follow());
    expect(follow()).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(within(sidebar()).getByRole('button', { name: /Fix flaky login test/ }));
    await waitFor(() => expect(follow()).toHaveAttribute('aria-pressed', 'true'));
  });

  it('opens a link to another session’s turn on that turn, paused', async () => {
    window.location.hash = '';
    // The snapshot arrives once the session opens, as it does from the server.
    const connect = (store: ReturnType<typeof createStore>, id: string | null) => {
      if (id === DEMO_SESSION_ID)
        store.applyEvent({
          type: 'snapshot',
          sessionId: id,
          snapshot: createDemoSnapshot(DEMO_NOW),
        });
      return () => {};
    };
    render(<App store={createStore()} connect={connect} />);
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}?turn=turn_m1`;
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Conversation 1: /),
    );
    const follow = within(screen.getByRole('banner')).getByRole('button', { name: /Follow/ });
    expect(follow).toHaveAttribute('aria-pressed', 'false');
  });

  it('loads a link to a turn on that turn, paused', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}?turn=turn_m1`;
    render(<App store={demoStore()} connect={noConnect} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Conversation 1: /);
    expect(
      within(screen.getByRole('banner')).getByRole('button', { name: /Follow/ }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps follow paused while the same session stays open', async () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    render(<App store={demoStore()} connect={noConnect} />);
    const follow = () => within(screen.getByRole('banner')).getByRole('button', { name: /Follow/ });
    fireEvent.click(follow());
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    await waitFor(() => expect(window.location.hash).toContain('tab=time'));
    expect(follow()).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows title, live state, summary, breadcrumb and tabs for the open session', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    const store = demoStore();
    store.setConnection('open');
    render(<App store={store} connect={noConnect} />);

    const banner = screen.getByRole('banner');
    expect(within(banner).getByText('Live viewer research (demo)')).toBeInTheDocument();
    expect(within(banner).getByText('Running')).toBeInTheDocument();
    expect(within(banner).getByText('Connected')).toBeInTheDocument();
    // The open session's agent, in its colours, at every width.
    expect(within(banner).getByText('Claude Code')).toHaveAttribute('data-tone', 'claude-code');

    const summary = screen.getByRole('region', { name: 'Summary' });
    const value = (label: string) =>
      within(summary).getByText(label).parentElement?.querySelector('[data-value]')?.textContent;
    expect(value('Conversations')).toBe('3');
    expect(value('Model calls')).toBe('28');
    expect(value('Tool calls')).toBe('24');
    expect(value('Duration')).toBe('3m4s');
    expect(value('Input')).toBe('1,838,850');
    expect(value('Cache hit')).toBe('86.0%');
    expect(value('Output (thinking)')).toBe('42,040 (27,050)');

    expect(screen.getByRole('navigation', { name: 'Agent' })).toHaveTextContent('Main');
    expect(within(summary).getByRole('button', { name: /^Data diagnostics/ })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Execution chain',
      'How it worked',
      'Where tokens went',
      'Timeline',
    ]);
    expect(screen.getByRole('tabpanel')).toContainElement(
      screen.getByRole('list', { name: 'Conversations' }),
    );
  });

  it('scopes the summary and breadcrumb to the agent in the route', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}?agent=af00000000000002`;
    render(<App store={demoStore()} connect={noConnect} />);
    expect(screen.getByRole('navigation', { name: 'Agent' })).toHaveTextContent(
      /Main.*cc-recon.*recon:prior-art/,
    );
    const summary = screen.getByRole('region', { name: 'Summary' });
    expect(
      within(summary).getByText('Model calls').parentElement?.querySelector('[data-value]')
        ?.textContent,
    ).toBe('9');
  });

  it('shows the tab named in the route', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}?tab=tokens`;
    render(<App store={demoStore()} connect={noConnect} />);
    expect(screen.getByRole('tab', { name: 'Where tokens went' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tabpanel')).toContainElement(
      screen.getByRole('region', { name: 'Total' }),
    );
  });

  it('shows the steps tab', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}?tab=steps&turn=turn_m1`;
    render(<App store={demoStore()} connect={noConnect} />);
    expect(screen.getByRole('tabpanel')).toContainElement(
      screen.getByRole('list', { name: 'Phase shares' }),
    );
  });

  it('shows the time tab', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}?tab=time`;
    render(<App store={demoStore()} connect={noConnect} />);
    expect(screen.getByRole('tabpanel')).toContainElement(
      screen.getByRole('img', { name: 'Timeline per agent' }),
    );
  });

  it('hides probe sessions until the settings toggle shows them', () => {
    localStorage.clear();
    const store = createStore();
    const [first] = createDemoSessions(DEMO_NOW);
    if (!first) throw new Error('fixture');
    store.applyEvent({
      type: 'sessions',
      sessions: [
        ...createDemoSessions(DEMO_NOW),
        {
          ...first,
          id: 'claude-code:probe',
          title: 'ClaudeBar Probe',
          project: 'Probe',
          tags: ['probe'],
        },
      ],
    });
    render(<App store={store} connect={noConnect} />);
    expect(within(sidebar()).queryByRole('button', { name: /ClaudeBar Probe/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show probe sessions' }));
    expect(within(sidebar()).getByRole('button', { name: /ClaudeBar Probe/ })).toBeInTheDocument();
    localStorage.clear();
  });

  it('shows the plan quota in the top bar', () => {
    const store = createStore();
    store.applyEvent({ type: 'quota', quotas: [createDemoQuota(DEMO_NOW)] });
    render(<App store={store} connect={noConnect} />);
    expect(
      within(screen.getByRole('banner')).getByRole('meter', { name: 'Claude' }),
    ).toHaveTextContent('Claude 62%');
  });

  it('says a session does not exist once the list has loaded without it', () => {
    window.location.hash = '#/s/claude-code%3Anope';
    const store = createStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    render(<App store={store} connect={noConnect} />);
    expect(screen.getByText('Session not found')).toBeInTheDocument();
  });

  it('puts the composer at the bottom, blocked for a session a terminal has open', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    render(<App store={demoStore()} connect={noConnect} runs={fakeRuns()} />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Continue in a copy' })).toBeInTheDocument();
  });

  it('shows a pending permission prompt of this session’s run and answers it', async () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    const store = demoStore();
    const runs = fakeRuns();
    store.applyEvent({
      type: 'run',
      run: runState({
        status: 'waiting-permission',
        pendingPermissions: [
          {
            id: 'tu_9',
            toolName: 'Bash',
            input: { command: 'ls' },
            questions: null,
            requestedAt: DEMO_NOW.toISOString(),
          },
        ],
      }),
    });
    render(<App store={store} connect={noConnect} runs={runs} />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(runs.decide).toHaveBeenCalledWith('run_1', 'tu_9', { decision: 'allow' }),
    );
  });

  it('collapses a permission prompt on Escape and reopens it from the composer', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    const store = demoStore();
    const prompt = (id: string) => ({
      id,
      toolName: 'Bash',
      input: { command: 'ls' },
      questions: null,
      requestedAt: DEMO_NOW.toISOString(),
    });
    store.applyEvent({
      type: 'run',
      run: runState({ status: 'waiting-permission', pendingPermissions: [prompt('tu_1')] }),
    });
    const runs = fakeRuns();
    render(<App store={store} connect={noConnect} runs={runs} />);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Claude Code wants to use Bash' }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('dialog', { name: 'Claude Code wants to use Bash' })).toBeNull();
    expect(runs.decide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review pending request' }));
    expect(
      screen.getByRole('dialog', { name: 'Claude Code wants to use Bash' }),
    ).toBeInTheDocument();
    // A newer prompt always shows itself.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    act(() =>
      store.applyEvent({
        type: 'run',
        run: runState({ status: 'waiting-permission', pendingPermissions: [prompt('tu_2')] }),
      }),
    );
    expect(
      screen.getByRole('dialog', { name: 'Claude Code wants to use Bash' }),
    ).toBeInTheDocument();
  });

  it('opens a new session once its run reports a session id', async () => {
    const store = createStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    const runs = fakeRuns();
    render(<App store={store} connect={noConnect} runs={runs} />);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), {
      target: { value: '/w/demo' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'First message' }), {
      target: { value: 'hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(runs.start).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
    act(() =>
      store.applyEvent({
        type: 'run',
        run: runState({ id: 'run_new', sessionId: 'claude-code:fresh', status: 'running' }),
      }),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe(`#/s/${encodeURIComponent('claude-code:fresh')}`),
    );
    expect(screen.queryByText('Session not found')).toBeNull();
  });

  it('moves between tabs with the arrow keys, Home and End (WAI-ARIA tabs)', async () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    render(<App store={demoStore()} connect={noConnect} runs={fakeRuns()} />);
    const tab = (name: string) => screen.getByRole('tab', { name });
    expect(tab('Execution chain')).toHaveAttribute('tabindex', '0');
    expect(tab('Timeline')).toHaveAttribute('tabindex', '-1');
    tab('Execution chain').focus();
    fireEvent.keyDown(tab('Execution chain'), { key: 'ArrowRight' });
    expect(tab('How it worked')).toHaveFocus();
    await waitFor(() => expect(window.location.hash).toContain('tab=steps'));
    fireEvent.keyDown(tab('How it worked'), { key: 'End' });
    expect(tab('Timeline')).toHaveFocus();
    fireEvent.keyDown(tab('Timeline'), { key: 'ArrowRight' });
    expect(tab('Execution chain')).toHaveFocus();
    fireEvent.keyDown(tab('Execution chain'), { key: 'ArrowLeft' });
    expect(tab('Timeline')).toHaveFocus();
    fireEvent.keyDown(tab('Timeline'), { key: 'Home' });
    expect(tab('Execution chain')).toHaveFocus();
  });

  it('switches agent from the breadcrumb dropdown', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    render(<App store={demoStore()} connect={noConnect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch agent' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Explore transcript format/ }));
    expect(window.location.hash).toContain('agent=a1b2c3d4e5f60718');
  });

  it('speaks English, and says so to the page, even in a Chinese browser', () => {
    localStorage.clear();
    const languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-CN', 'zh']);
    onTestFinished(() => languages.mockRestore());
    render(<App store={createStore()} connect={noConnect} runs={fakeRuns()} />);
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });

  it('switches to Chinese from the settings and remembers the choice', () => {
    localStorage.clear();
    onTestFinished(() => localStorage.clear());
    const { unmount } = render(<App store={createStore()} connect={noConnect} runs={fakeRuns()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const language = screen.getByRole('combobox', { name: 'Language' });
    expect(
      within(language)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['English', '中文']);
    fireEvent.change(language, { target: { value: 'zh' } });
    expect(document.documentElement.lang).toBe('zh-CN');
    unmount();
    render(<App store={createStore()} connect={noConnect} runs={fakeRuns()} />);
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
  });

  it('shows the reconnecting state', () => {
    const store = createStore();
    act(() => store.setConnection('reconnecting'));
    render(<App store={store} connect={noConnect} />);
    expect(screen.getByRole('status')).toHaveTextContent('Disconnected, reconnecting…');
  });
});

describe('App · permission prompts in the views', () => {
  useFakeLayout();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEMO_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    window.location.hash = '';
  });

  it('shows a tool blocked on a permission prompt as waiting for you, not running', async () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    const snapshot = createDemoSnapshot(DEMO_NOW);
    snapshot.toolCalls = snapshot.toolCalls.map((t) =>
      t.id === 'tu_m1a' ? { ...t, status: 'running', endedAt: null, durationMs: null } : t,
    );
    const store = createStore();
    store.openSession(DEMO_SESSION_ID);
    store.applyEvent({ type: 'snapshot', sessionId: DEMO_SESSION_ID, snapshot });
    store.applyEvent({
      type: 'run',
      run: runState({
        status: 'waiting-permission',
        pendingPermissions: [
          {
            id: 'tu_m1a',
            toolName: 'Grep',
            input: {},
            questions: null,
            // Asked as the tool started, as Claude Code does.
            requestedAt: snapshot.toolCalls.find((t) => t.id === 'tu_m1a')?.startedAt ?? '',
          },
        ],
      }),
    });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    fireEvent.click(screen.getByRole('button', { name: /Busy sessions/ }));

    const call = screen.getByRole('article', { name: 'Model call #1' });
    expect(within(call).getAllByText('Waiting for you').length).toBeGreaterThanOrEqual(2);
    expect(within(call).queryByText(/Running/)).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'How it worked' }));
    const step = await screen.findByRole('article', { name: 'Step 1' });
    expect(step).toHaveAttribute('data-outcome', 'approval');
    // The step's outcome badge and the blocked tool's own line.
    expect(within(step).getAllByText('Waiting for you')).toHaveLength(2);

    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect((await screen.findAllByText('Waiting for you (permission)')).length).toBeGreaterThan(0);
  });

  it('counts prompts answered in an earlier, closed run as time waiting for you', async () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}?tab=time`;
    const store = demoStore();
    const tool = store.getState().open?.toolCalls.get('tu_m1a');
    const start = Date.parse(tool?.startedAt ?? '');
    store.applyEvent({
      type: 'run',
      run: runState({
        id: 'run_old',
        status: 'closed',
        decidedPermissions: [
          {
            id: 'tu_m1a',
            toolName: 'Grep',
            requestedAt: new Date(start + 100).toISOString(),
            decidedAt: new Date(start + 300).toISOString(),
            decision: 'allow',
          },
        ],
      }),
    });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    expect((await screen.findAllByText('Waiting for you (permission)')).length).toBeGreaterThan(0);
  });

  it('names a non-Claude session’s agent in the permission prompt and the composer note', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    const snapshot = createDemoSnapshot(DEMO_NOW);
    // Closed, so the composer offers to send instead of explaining why it cannot.
    snapshot.session = { ...snapshot.session, agent: 'grok', live: 'closed' };
    const store = createStore();
    store.openSession(DEMO_SESSION_ID);
    store.applyEvent({ type: 'snapshot', sessionId: DEMO_SESSION_ID, snapshot });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    // glassbox cannot run Grok: its sessions are view-only.
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute(
      'placeholder',
      'Grok sessions are view-only; start a Claude Code session with “New session”',
    );
    act(() =>
      store.applyEvent({
        type: 'run',
        run: runState({
          status: 'waiting-permission',
          pendingPermissions: [
            {
              id: 'tu_9',
              toolName: 'Bash',
              input: { command: 'ls' },
              questions: null,
              requestedAt: DEMO_NOW.toISOString(),
            },
          ],
        }),
      }),
    );
    expect(screen.getByRole('dialog', { name: 'Grok wants to use Bash' })).toBeInTheDocument();
  });
});

describe('App token rate', () => {
  const tail = (...v: number[]) => [...new Array<number>(60 - v.length).fill(0), ...v];
  const minute = Date.UTC(2026, 9, 23, 2, 0, 0);
  const rate = {
    minute: new Date(minute).toISOString(),
    at: new Date(minute + 30_000).toISOString(),
    since: new Date(minute - 3_600_000).toISOString(),
    agents: {
      'claude-code': {
        input: tail(0),
        cacheRead: tail(900_000, 900_000, 900_000, 900_000, 450_000),
        cacheWrite: tail(0),
        output: tail(0),
      },
      codex: {
        input: tail(0),
        cacheRead: tail(90_000, 90_000, 90_000, 90_000, 45_000),
        cacheWrite: tail(0),
        output: tail(0),
      },
    },
    coverage: { running: 2, counted: 2, agents: {} },
  };

  it('shows the machine’s token rate in the top bar, and remembers the CLI picked', () => {
    localStorage.clear();
    const store = createStore();
    store.applyEvent({ type: 'rate', rate });
    render(<App store={store} connect={noConnect} />);
    const banner = screen.getByRole('banner');
    const instrument = within(banner).getByRole('button', {
      name: /^Token rate: 990K tokens a minute/,
    });
    fireEvent.click(instrument);
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Show the rate of' })).getByRole('button', {
        name: 'Codex',
      }),
    );
    expect(
      within(banner).getByRole('button', { name: /^Token rate of Codex: 90K tokens a minute/ }),
    ).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('glassbox.prefs') ?? '{}')).toMatchObject({
      rateAgent: 'codex',
    });
  });
});

describe('sidebarMode', () => {
  it.each([
    [1440, true, 'column'],
    [1440, false, 'column'],
    [1200, true, 'column'],
    [1199, true, 'overlay'],
    [1024, true, 'overlay'],
    [1024, false, 'column'],
    [901, true, 'overlay'],
    [900, true, 'drawer'],
    [768, false, 'drawer'],
  ] as const)('%ipx, session open: %s → %s', (width, hasSession, mode) => {
    expect(sidebarMode(width, hasSession)).toBe(mode);
  });
});

describe('App below three columns', () => {
  const realMatchMedia = window.matchMedia;
  let width = 1440;
  const listeners = new Set<() => void>();
  /** A screen `w` px wide that can be resized: answers the app's max-width queries. */
  const screenWidth = (w: number) => {
    width = w;
    window.matchMedia = ((query: string) => ({
      get matches() {
        const max = Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Number.POSITIVE_INFINITY);
        return width <= max;
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    })) as unknown as typeof window.matchMedia;
  };
  const resize = (w: number) =>
    act(() => {
      width = w;
      for (const fn of [...listeners]) fn();
    });
  afterEach(() => {
    window.matchMedia = realMatchMedia;
    listeners.clear();
  });
  const openOverlay = (sessions = false) => {
    screenWidth(1024);
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    const store = demoStore();
    if (sessions) store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    render(<App store={store} connect={noConnect} />);
    const menu = within(screen.getByRole('banner')).getByRole('button', { name: 'Sessions' });
    fireEvent.click(menu);
    return menu;
  };

  it('floats the session list over an open session as a modal, closed until the menu opens it', () => {
    screenWidth(1024);
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    render(<App store={demoStore()} connect={noConnect} />);
    const banner = screen.getByRole('banner');
    const menu = within(banner).getByRole('button', { name: 'Sessions' });
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).toBeNull();
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(menu).toHaveAttribute('aria-controls', 'session-list');
    expect(within(banner).getByText('Claude Code')).toBeInTheDocument();

    fireEvent.click(menu);
    const dialog = screen.getByRole('dialog', { name: 'Sessions' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('id', 'session-list');
    expect(dialog.closest('[data-sidebar-mode]')).toHaveAttribute('data-sidebar-mode', 'overlay');
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    expect(document.activeElement).toBe(within(dialog).getByRole('searchbox'));
    // Nothing behind the scrim takes focus while it is open.
    expect(screen.getByRole('main', { hidden: true })).toHaveAttribute('inert');
    expect(document.getElementById('composer-slot')).toHaveAttribute('inert');
  });

  it('closes on Escape wherever focus is, and gives focus back to the menu', () => {
    const menu = openOverlay();
    act(() => (document.activeElement as HTMLElement).blur());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Sessions' })).toBeNull();
    expect(document.activeElement).toBe(menu);
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');
  });

  it('closes from the scrim, giving focus back to the menu', () => {
    const menu = openOverlay();
    const scrim = document.querySelector(
      '[data-sidebar-mode] > [aria-hidden="true"]',
    ) as HTMLElement;
    fireEvent.click(scrim);
    expect(screen.queryByRole('dialog', { name: 'Sessions' })).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it('closes once a session is picked, and carries on in the session just opened', () => {
    // As a browser does, and jsdom does not: no focus inside an inert subtree.
    const realFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
      if (!this.closest('[inert]')) realFocus.call(this, options);
    };
    onTestFinished(() => {
      HTMLElement.prototype.focus = realFocus;
    });
    openOverlay(true);
    fireEvent.click(screen.getByRole('button', { name: /Fix flaky login test/ }));
    expect(screen.queryByRole('dialog', { name: 'Sessions' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('closes when the screen crosses a breakpoint, keeping focus on the page', () => {
    const menu = openOverlay();
    resize(800);
    expect(screen.queryByRole('dialog', { name: 'Sessions' })).toBeNull();
    expect(document.activeElement).toBe(menu);
    // Wide again: a column, not a dialog, and nothing inert.
    resize(1300);
    expect(
      screen.getByRole('navigation', { name: 'Sessions' }).closest('aside'),
    ).not.toHaveAttribute('role');
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');
  });

  it('keeps the list as a column on Home, which has no third column to protect', () => {
    screenWidth(1024);
    window.location.hash = '';
    render(<App store={demoStore()} connect={noConnect} />);
    const list = screen.getByRole('navigation', { name: 'Sessions' });
    expect(list.closest('[data-sidebar-mode]')).toHaveAttribute('data-sidebar-mode', 'column');
  });
});
