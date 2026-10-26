import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createDemoQuota,
  createDemoSessions,
  createDemoSnapshot,
  DEMO_SESSION_ID,
} from '../../src/core/fixtures/demo.js';
import type { RunState } from '../../src/shared/runs.js';
import { App, documentTitle, sidebarMode } from './App';
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
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(within(sidebar()).getAllByRole('list')).toHaveLength(3);
    // No session open: the header names no agent.
    expect(within(screen.getByRole('banner')).queryByText('Claude Code')).toBeNull();
  });

  it('does not claim there are no sessions before the list has arrived', () => {
    render(<App store={createStore()} connect={noConnect} runs={fakeRuns()} />);
    expect(screen.queryByText(/No sessions on this machine/)).toBeNull();
  });

  it('welcomes a first-time user: what glassbox reads and how to start', () => {
    const store = createStore();
    store.applyEvent({ type: 'sessions', sessions: [] });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    expect(
      screen.getByRole('heading', { name: 'No sessions on this machine' }),
    ).toBeInTheDocument();
    // Every agent glassbox reads, where from, and how to change it.
    for (const s of ['~/.claude/projects', '--claude-dir', '~/.grok', '--grok-dir', '--no-grok'])
      expect(screen.getByRole('main')).toHaveTextContent(s);
    expect(screen.getByRole('main')).toHaveTextContent('read-only');
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'New session' }));
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeInTheDocument();
  });

  it('puts the working sessions on the home screen, after those that need you', () => {
    const store = createStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    const working = screen.getByRole('region', { name: 'Working' });
    const card = within(working).getByRole('button', { name: /Live viewer research/ });
    expect(within(card).getByText('Claude Code')).toHaveAttribute('data-agent', 'claude-code');
    expect(within(working).queryByRole('button', { name: /Fix flaky login/ })).toBeNull();
    expect(screen.getByRole('region', { name: 'Needs you' })).toHaveTextContent(
      'Nothing needs you.',
    );
    // The Session page opens the most recently active session; Home offers a new one.
    expect(screen.queryByRole('button', { name: /most recently active/ })).toBeNull();
    expect(
      within(screen.getByRole('main')).getByRole('button', { name: 'New session' }),
    ).toBeInTheDocument();
  });

  it('offers recent sessions when nothing is working', () => {
    const store = createStore();
    const [, idle, closed] = createDemoSessions(DEMO_NOW);
    if (!idle || !closed) throw new Error('fixture');
    store.applyEvent({ type: 'sessions', sessions: [closed, idle] });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    // Nothing works, and Working says so (W6-fix1 DR3).
    const working = screen.getByRole('region', { name: 'Working' });
    expect(working).toHaveTextContent('Nothing is working.');
    expect(within(working).queryByRole('listitem')).toBeNull();
    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(
      within(recent)
        .getAllByRole('listitem')
        .map((b) => b.textContent),
    ).toEqual([
      expect.stringContaining('Fix flaky login test'),
      expect.stringContaining('Untitled session'),
    ]);
  });

  // F1: the session that needs a decision leads the board, saying what for, and a click lands on
  // the prompt itself, even one hidden with Escape before.
  it('lists a session with an open permission prompt under Needs you, and opens it onto the prompt', async () => {
    const store = createStore();
    const [, idle] = createDemoSessions(DEMO_NOW);
    if (!idle) throw new Error('fixture');
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    const prompt = {
      id: 'tu_1',
      toolName: 'Bash',
      input: { command: 'ls' },
      questions: null,
      requestedAt: new Date(DEMO_NOW.getTime() - 20_000).toISOString(),
    };
    store.applyEvent({
      type: 'run',
      run: runState({
        id: 'run_2',
        sessionId: idle.id,
        status: 'waiting-permission',
        pendingPermissions: [prompt],
      }),
    });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    const needsYou = screen.getByRole('region', { name: 'Needs you' });
    const card = within(needsYou).getByRole('button', { name: /Fix flaky login test/ });
    expect(card).toHaveTextContent('Permission · Bash · 0:20');
    // glassbox holds this prompt, not a terminal.
    expect(card).not.toHaveTextContent('terminal');
    expect(
      within(screen.getByRole('region', { name: 'Recent' })).queryByRole('button', {
        name: /Fix flaky login test/,
      }),
    ).toBeNull();
    // No composer on Home: the prompt belongs to the session page.
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(card);
    await waitFor(() => expect(window.location.hash).toBe(`#/s/${encodeURIComponent(idle.id)}`));
    const dialog = await screen.findByRole('dialog', { name: 'Claude Code wants to use Bash' });
    expect(dialog).toHaveFocus();

    // Hidden with Escape, then back from Home: the row opens it again.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => {
      window.location.hash = '#/';
    });
    const again = await within(await screen.findByRole('region', { name: 'Needs you' })).findByRole(
      'button',
      { name: /Fix flaky login test/ },
    );
    fireEvent.click(again);
    expect(
      await screen.findByRole('dialog', { name: 'Claude Code wants to use Bash' }),
    ).toBeInTheDocument();
  });

  it('answers a prompt from Home through its run, and the row is Working after the next update', async () => {
    const store = createStore();
    const [demo, other] = createDemoSessions(DEMO_NOW);
    if (!demo || !other) throw new Error('fixture');
    // A glassbox run's process only knows it is busy; the prompt is what makes it wait.
    const busy = { ...other, live: 'busy' as const };
    store.applyEvent({ type: 'sessions', sessions: [demo, busy] });
    const prompt = {
      id: 'tu_1',
      toolName: 'Bash',
      input: { command: 'npm test' },
      questions: null,
      requestedAt: new Date(DEMO_NOW.getTime() - 20_000).toISOString(),
    };
    const waiting = runState({
      id: 'run_2',
      sessionId: other.id,
      status: 'waiting-permission',
      pendingPermissions: [prompt],
    });
    store.applyEvent({ type: 'run', run: waiting });
    const runs = fakeRuns();
    render(<App store={store} connect={noConnect} runs={runs} />);
    const needsYou = screen.getByRole('region', { name: 'Needs you' });
    const answer = within(needsYou).getByRole('group', {
      name: 'Permission for Bash · Fix flaky login test',
    });
    expect(answer).toHaveTextContent('npm test');
    const allow = within(answer).getByRole('button', { name: 'Allow' });
    await waitFor(() => expect(allow).toBeEnabled());
    fireEvent.click(allow);
    await waitFor(() =>
      expect(runs.decide).toHaveBeenCalledWith('run_2', 'tu_1', { decision: 'allow' }),
    );

    act(() =>
      store.applyEvent({
        type: 'run',
        run: { ...waiting, status: 'running', pendingPermissions: [] },
      }),
    );
    expect(
      within(screen.getByRole('region', { name: 'Working' })).getByRole('button', {
        name: /Fix flaky login test/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Needs you' })).toHaveTextContent(
      'Nothing needs you.',
    );
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
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Prompt 1: /),
    );
    const follow = within(screen.getByRole('banner')).getByRole('button', { name: /Follow/ });
    expect(follow).toHaveAttribute('aria-pressed', 'false');
  });

  it('loads a link to a turn on that turn, paused', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}?turn=turn_m1`;
    render(<App store={demoStore()} connect={noConnect} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Prompt 1: /);
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
    expect(value('Prompts')).toBe('3');
    expect(value('Model calls')).toBe('28');
    expect(value('Tool calls')).toBe('32');
    expect(value('Active time')).toBe('3m4s');
    expect(value('Input')).toBe('1.84M');
    expect(value('Cache hit')).toBe('86.0%');
    expect(value('Output (thinking)')).toBe('42K (27.1K)');

    expect(screen.getByRole('navigation', { name: 'Agent' })).toHaveTextContent('Main');
    expect(within(summary).getByRole('button', { name: /^Data diagnostics/ })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Execution chain',
      'How it worked',
      'Where tokens went',
      'Timeline',
      'Files',
    ]);
    expect(screen.getByRole('tabpanel')).toContainElement(
      screen.getByRole('list', { name: 'Prompts' }),
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

  it('shows the tab named in the route', async () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}?tab=tokens`;
    render(<App store={demoStore()} connect={noConnect} />);
    expect(screen.getByRole('tab', { name: 'Where tokens went' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Loaded on first use (its own chunk, I3b).
    expect(screen.getByRole('tabpanel')).toContainElement(
      await screen.findByRole('region', { name: 'Total' }),
    );
  });

  it('shows the steps tab', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}?tab=steps&turn=turn_m1`;
    render(<App store={demoStore()} connect={noConnect} />);
    expect(screen.getByRole('tabpanel')).toContainElement(
      screen.getByRole('list', { name: 'Phase shares' }),
    );
  });

  it('shows the time tab', async () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}?tab=time`;
    render(<App store={demoStore()} connect={noConnect} />);
    expect(screen.getByRole('tabpanel')).toContainElement(
      await screen.findByRole('img', { name: 'Timeline per agent' }),
    );
  });

  it('shows the files tab, loaded on first use', async () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}?tab=files`;
    render(<App store={demoStore()} connect={noConnect} />);
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toContainElement(
      await screen.findByRole('heading', { level: 3, name: 'src/server' }),
    );
    // The tab's own head; the outcome strip above the tabs counts the same files.
    expect(
      within(screen.getByRole('tabpanel'))
        .getByText(/files edited/)
        .closest('p'),
    ).toHaveTextContent('3 files edited · 1 created · 3 read · Main');
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

  it('puts the composer at the bottom, continuing a session a terminal has open in a copy', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    render(<App store={demoStore()} connect={noConnect} runs={fakeRuns()} />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Continue in a copy' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
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
    // A prompt's buttons arm a moment after it appears (a double-click must not answer the next).
    const allow = screen.getByRole('button', { name: 'Allow' });
    await waitFor(() => expect(allow).toBeEnabled());
    fireEvent.click(allow);
    await waitFor(() =>
      expect(runs.decide).toHaveBeenCalledWith('run_1', 'tu_9', { decision: 'allow' }),
    );
  });

  // W6-fix1 C2: back on Home, the tab stop is on the row of the session just left.
  it('keeps Home’s tab stop on the session the user comes back from', async () => {
    const store = createStore();
    const [, idle] = createDemoSessions(DEMO_NOW);
    if (!idle) throw new Error('fixture');
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    const card = () =>
      within(screen.getByRole('main')).getByRole('button', { name: /Fix flaky login test/ });
    expect(card().tabIndex).toBe(-1);
    fireEvent.click(card());
    await waitFor(() => expect(store.getState().openId).toBe(idle.id));
    window.location.hash = '#/';
    await waitFor(() => expect(screen.getByRole('region', { name: 'Recent' })).toBeInTheDocument());
    expect(card().tabIndex).toBe(0);
    const stops = within(screen.getByRole('main'))
      .getAllByRole('listitem')
      .filter((li) => li.querySelector('button')?.tabIndex === 0);
    expect(stops).toHaveLength(1);
  });

  // W6: a glassbox run that failed says so where its session is listed: why, on Home's board.
  it('says a session whose glassbox run failed failed, on Home and in the sidebar', () => {
    const store = createStore();
    const [, idle] = createDemoSessions(DEMO_NOW);
    if (!idle) throw new Error('fixture');
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    act(() =>
      store.applyEvent({
        type: 'run',
        run: runState({ id: 'run_2', sessionId: idle.id, status: 'error', error: 'missing file' }),
      }),
    );
    const card = within(screen.getByRole('region', { name: 'Recent' })).getByRole('button', {
      name: /Fix flaky login test/,
    });
    expect(card).toHaveTextContent('Failed · missing file');
    const row = within(sidebar()).getByRole('button', { name: /Fix flaky login test/ });
    expect(row).toHaveTextContent('Failed');
    expect(row).not.toHaveTextContent('missing file');
  });

  // I3: the same pending prompt the composer shows makes the session "Waiting for you" in the
  // top bar and on its sidebar row, with W1's waiting mark, though its process says busy.
  it('says a session with an open permission prompt is waiting for you, in the top bar and sidebar', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    const store = demoStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    const top = screen.getByRole('banner');
    const row = () => within(sidebar()).getByRole('button', { name: /Live viewer research/ });
    expect(top).toHaveTextContent('Running');
    expect(row()).toHaveTextContent('Running');
    act(() =>
      store.applyEvent({
        type: 'run',
        run: runState({
          status: 'waiting-permission',
          pendingPermissions: [
            {
              id: 'tu_1',
              toolName: 'Bash',
              input: { command: 'ls' },
              questions: null,
              requestedAt: DEMO_NOW.toISOString(),
            },
          ],
        }),
      }),
    );
    for (const where of [top, row()])
      expect(where.querySelector('[data-kind="live"][data-state="waiting"]')).not.toBeNull();
    // The top bar says it waits for you; the row says for what, in the words of Home's board.
    expect(top).toHaveTextContent('Waiting for you');
    expect(row()).toHaveTextContent('Permission · Bash');
    // Answered: back to what the process says.
    act(() => store.applyEvent({ type: 'run', run: runState({ status: 'running' }) }));
    expect(top).toHaveTextContent('Running');
    expect(row()).not.toHaveTextContent('Permission');
  });

  // I3b F2: one derivation (waitingSessionIds) for the top bar and the list, so they agree even
  // when the prompt is on an older run than the one the composer follows.
  it('says waiting in the top bar and the row alike when an older run holds the prompt', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    const store = demoStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    store.applyEvent({
      type: 'run',
      run: runState({
        id: 'run_old',
        status: 'waiting-permission',
        updatedAt: '2026-10-23T09:00:00.000Z',
        pendingPermissions: [
          {
            id: 'tu_old',
            toolName: 'Bash',
            input: { command: 'ls' },
            questions: null,
            requestedAt: DEMO_NOW.toISOString(),
          },
        ],
      }),
    });
    store.applyEvent({ type: 'run', run: runState({ id: 'run_new', status: 'running' }) });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    const row = within(sidebar()).getByRole('button', { name: /Live viewer research/ });
    expect(row).toHaveTextContent('Permission · Bash');
    expect(screen.getByRole('banner')).toHaveTextContent('Waiting for you');
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
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'New session' }));
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
    expect(tab('Files')).toHaveAttribute('tabindex', '-1');
    tab('Execution chain').focus();
    fireEvent.keyDown(tab('Execution chain'), { key: 'ArrowRight' });
    expect(tab('How it worked')).toHaveFocus();
    await waitFor(() => expect(window.location.hash).toContain('tab=steps'));
    // Files is the last tab: End lands on it, and it wraps round to the first.
    fireEvent.keyDown(tab('How it worked'), { key: 'End' });
    expect(tab('Files')).toHaveFocus();
    await waitFor(() => expect(window.location.hash).toContain('tab=files'));
    fireEvent.keyDown(tab('Files'), { key: 'ArrowLeft' });
    expect(tab('Timeline')).toHaveFocus();
    fireEvent.keyDown(tab('Timeline'), { key: 'ArrowRight' });
    expect(tab('Files')).toHaveFocus();
    fireEvent.keyDown(tab('Files'), { key: 'ArrowRight' });
    expect(tab('Execution chain')).toHaveFocus();
    fireEvent.keyDown(tab('Execution chain'), { key: 'ArrowLeft' });
    expect(tab('Files')).toHaveFocus();
    fireEvent.keyDown(tab('Files'), { key: 'Home' });
    expect(tab('Execution chain')).toHaveFocus();
  });

  it('switches agent from the breadcrumb dropdown', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    render(<App store={demoStore()} connect={noConnect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch sub-agent' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Explore transcript format/ }));
    expect(window.location.hash).toContain('agent=a1b2c3d4e5f60718');
  });

  // Final review M9: every popover closes on Escape and gives focus back to its trigger.
  it('closes each popover on Escape, wherever focus is, and focuses its trigger again', () => {
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    const store = demoStore();
    store.applyEvent({ type: 'quota', quotas: [createDemoQuota(DEMO_NOW)] });
    render(<App store={store} connect={noConnect} />);
    for (const name of ['Settings', /^Plan quota/, /^Data diagnostics/, 'Switch sub-agent']) {
      const trigger = screen.getByRole('button', { name });
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveFocus();
    }
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

// F1: optional desktop notifications, off by default.
describe('App notifications', () => {
  class FakeNotification {
    static permission: NotificationPermission = 'granted';
    static requestPermission = vi.fn(async () => FakeNotification.permission);
    static shown: FakeNotification[] = [];
    onclick: (() => void) | null = null;
    constructor(
      public title: string,
      public options?: NotificationOptions,
    ) {
      FakeNotification.shown.push(this);
    }
    close() {}
  }
  const notifyBox = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    return screen.getByRole('checkbox', {
      name: 'Notify me when a session needs me or looks stuck',
    });
  };
  const saved = () => JSON.parse(localStorage.getItem('glassbox.prefs') ?? '{}');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEMO_NOW);
    window.location.hash = '';
    localStorage.clear();
    FakeNotification.permission = 'granted';
    FakeNotification.requestPermission = vi.fn(async () => FakeNotification.permission);
    FakeNotification.shown = [];
    vi.stubGlobal('Notification', FakeNotification);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.location.hash = '';
    localStorage.clear();
  });

  it('asks the browser once when turned on, and stays off, saying so, when it refuses', async () => {
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission = vi.fn(async () => {
      FakeNotification.permission = 'denied';
      return 'denied' as const;
    });
    render(<App store={createStore()} connect={noConnect} runs={fakeRuns()} />);
    const box = notifyBox();
    expect(box).not.toBeChecked();
    expect(box).toBeEnabled();
    expect(box).not.toHaveAccessibleDescription();
    fireEvent.click(box);
    await waitFor(() =>
      expect(box).toHaveAccessibleDescription('Blocked in the browser’s site settings'),
    );
    expect(box).not.toBeChecked();
    expect(saved()).toMatchObject({ notify: false });
    // Refused once: the browser remembers, so it is not asked again.
    fireEvent.click(box);
    await act(async () => {});
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(box).not.toBeChecked();
  });

  it('turns on once the browser allows it, remembers, and turns off again', async () => {
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission = vi.fn(async () => {
      FakeNotification.permission = 'granted';
      return 'granted' as const;
    });
    render(<App store={createStore()} connect={noConnect} runs={fakeRuns()} />);
    const box = notifyBox();
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(saved()).toMatchObject({ notify: true });
    expect(box).not.toHaveAccessibleDescription();
    fireEvent.click(box);
    expect(box).not.toBeChecked();
    expect(saved()).toMatchObject({ notify: false });
  });

  it('says so, and cannot be turned on, when the browser offers no notifications', () => {
    vi.stubGlobal('Notification', undefined);
    render(<App store={createStore()} connect={noConnect} runs={fakeRuns()} />);
    const box = notifyBox();
    expect(box).toBeDisabled();
    expect(box).toHaveAccessibleDescription('Not offered by this browser');
  });

  it('notifies once as a running session begins to look stuck, its sign the body', () => {
    localStorage.setItem('glassbox.prefs', JSON.stringify({ notify: true }));
    const store = createStore();
    const [busy, ...rest] = createDemoSessions(DEMO_NOW);
    if (!busy) throw new Error('fixture');
    store.applyEvent({ type: 'sessions', sessions: [{ ...busy, trouble: null }, ...rest] });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    const sign = {
      kind: 'repeat' as const,
      params: { x: 'npm test', n: 4 },
      at: null,
      since: DEMO_NOW.toISOString(),
    };
    act(() =>
      store.applyEvent({ type: 'sessions', sessions: [{ ...busy, trouble: sign }, ...rest] }),
    );
    act(() =>
      store.applyEvent({
        type: 'sessions',
        sessions: [{ ...busy, trouble: { ...sign, params: { x: 'npm test', n: 5 } } }, ...rest],
      }),
    );
    expect(FakeNotification.shown.map((x) => [x.title, x.options?.body])).toEqual([
      ['glassbox / Live viewer research (demo)', 'Repeated npm test 4×'],
    ]);
  });

  it('tells nothing of a sign the server says first, when it opens a running session', () => {
    localStorage.setItem('glassbox.prefs', JSON.stringify({ notify: true }));
    const store = createStore();
    const [busy, ...rest] = createDemoSessions(DEMO_NOW);
    if (!busy) throw new Error('fixture');
    // Listed before the server has read it: its signs are not known yet.
    store.applyEvent({ type: 'sessions', sessions: [busy, ...rest] });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    const old = { kind: 'compaction' as const, params: { n: 4 }, at: null, since: null };
    act(() =>
      store.applyEvent({ type: 'sessions', sessions: [{ ...busy, trouble: old }, ...rest] }),
    );
    expect(FakeNotification.shown).toEqual([]);
  });

  it('notifies once as a session begins to wait, not on page load, and opens it from the notification', async () => {
    localStorage.setItem('glassbox.prefs', JSON.stringify({ notify: true }));
    const store = createStore();
    const all = createDemoSessions(DEMO_NOW);
    const [, idle, closed] = all;
    if (!idle || !closed) throw new Error('fixture');
    const prompt = (requestedAt: string) => ({
      id: 'tu_1',
      toolName: 'Bash',
      input: { command: 'ls' },
      questions: null,
      requestedAt,
    });
    // Already waiting when the page loads: one a terminal holds, one with a prompt open.
    store.applyEvent({
      type: 'sessions',
      sessions: [all[0] as (typeof all)[0], idle, { ...closed, live: 'waiting' }],
    });
    store.applyEvent({
      type: 'run',
      run: runState({
        id: 'run_old',
        sessionId: idle.id,
        status: 'waiting-permission',
        pendingPermissions: [prompt(new Date(DEMO_NOW.getTime() - 20_000).toISOString())],
      }),
    });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    expect(screen.getByRole('region', { name: 'Needs you' })).toHaveTextContent(
      'Permission · Bash',
    );
    expect(FakeNotification.shown).toEqual([]);

    // Answered, then asked again: a new wait.
    act(() =>
      store.applyEvent({ type: 'run', run: runState({ id: 'run_old', sessionId: idle.id }) }),
    );
    act(() =>
      store.applyEvent({
        type: 'run',
        run: runState({
          id: 'run_old',
          sessionId: idle.id,
          status: 'waiting-permission',
          pendingPermissions: [prompt(new Date(DEMO_NOW.getTime() + 1000).toISOString())],
        }),
      }),
    );
    expect(
      FakeNotification.shown.map((x) => [x.title, x.options?.body, x.options?.silent]),
    ).toEqual([['shopfront / Fix flaky login test', 'Permission · Bash', true]]);
    // The reply streams on: every run event repeats the prompt, and none is a new wait.
    act(() =>
      store.applyEvent({
        type: 'run',
        run: runState({
          id: 'run_old',
          sessionId: idle.id,
          status: 'waiting-permission',
          pendingPermissions: [prompt(new Date(DEMO_NOW.getTime() + 1000).toISOString())],
          updatedAt: new Date(DEMO_NOW.getTime() + 2000).toISOString(),
        }),
      }),
    );
    expect(FakeNotification.shown).toHaveLength(1);

    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    act(() => FakeNotification.shown[0]?.onclick?.());
    expect(focus).toHaveBeenCalled();
    await waitFor(() => expect(window.location.hash).toBe(`#/s/${encodeURIComponent(idle.id)}`));
    expect(
      await screen.findByRole('dialog', { name: 'Claude Code wants to use Bash' }),
    ).toBeInTheDocument();
    focus.mockRestore();
  });

  it('notifies nothing while the setting is off', () => {
    const store = createStore();
    const [, idle] = createDemoSessions(DEMO_NOW);
    if (!idle) throw new Error('fixture');
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    act(() =>
      store.applyEvent({
        type: 'run',
        run: runState({
          id: 'run_2',
          sessionId: idle.id,
          status: 'waiting-permission',
          pendingPermissions: [
            {
              id: 'tu_1',
              toolName: 'Bash',
              input: {},
              questions: null,
              requestedAt: new Date(DEMO_NOW.getTime() + 1000).toISOString(),
            },
          ],
        }),
      }),
    );
    expect(FakeNotification.shown).toEqual([]);
    expect(document.title).toBe('(1) glassbox');
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

describe('App top-bar popovers', () => {
  it('keeps one open at a time, also when opened from the keyboard', () => {
    const store = createStore();
    store.applyEvent({ type: 'quota', quotas: [createDemoQuota(DEMO_NOW)] });
    store.applyEvent({
      type: 'rate',
      rate: {
        minute: '2026-10-23T02:00:00.000Z',
        at: '2026-10-23T02:00:30.000Z',
        since: '2026-10-23T01:00:00.000Z',
        agents: {},
        coverage: { running: 0, counted: 0, agents: {} },
      },
    });
    render(<App store={store} connect={noConnect} />);
    const banner = screen.getByRole('banner');
    // A keyboard press is a click with no pointerdown before it.
    fireEvent.click(within(banner).getByRole('button', { name: /Plan quota/ }));
    expect(screen.getByRole('dialog', { name: 'Plan quota' })).toBeInTheDocument();
    fireEvent.click(within(banner).getByRole('button', { name: /^Token rate/ }));
    expect(screen.getByRole('dialog', { name: 'Token rate' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Plan quota' })).toBeNull();
  });
});

describe('App keyboard shortcuts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEMO_NOW);
    window.location.hash = '';
  });
  afterEach(() => {
    vi.useRealTimers();
    window.location.hash = '';
  });
  const key = (k: string, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(document.activeElement ?? document.body, { key: k, ...init });
  const demoLink = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;

  it('goes to Stats, Home and back to the session with g t, g h and g s', async () => {
    window.location.hash = demoLink;
    const store = demoStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    key('g');
    key('t');
    await waitFor(() => expect(window.location.hash).toBe('#/stats'));
    key('g');
    key('h');
    await waitFor(() => expect(window.location.hash).toBe('#/'));
    key('g');
    key('s');
    await waitFor(() => expect(window.location.hash).toBe(demoLink));
  });

  it('switches the session page’s tab with 1 to 5', async () => {
    window.location.hash = demoLink;
    render(<App store={demoStore()} connect={noConnect} runs={fakeRuns()} />);
    const selected = () =>
      screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')
        ?.textContent;
    key('2');
    await waitFor(() => expect(selected()).toBe('How it worked'));
    key('5');
    await waitFor(() => expect(selected()).toBe('Files'));
    key('1');
    await waitFor(() => expect(selected()).toBe('Execution chain'));
  });

  it('moves along the prompt list with j and k, as a click on a row does', async () => {
    window.location.hash = demoLink;
    render(<App store={demoStore()} connect={noConnect} runs={fakeRuns()} />);
    // Newest on top, following it: j goes down the list, to older prompts, and stops at the end.
    const current = () =>
      within(screen.getByRole('list', { name: 'Prompts' }))
        .getAllByRole('button')
        .find((b) => b.getAttribute('aria-current') === 'true')?.textContent;
    expect(current()).toMatch(/design document/);
    key('j');
    await waitFor(() => expect(current()).toMatch(/Research how a live viewer/));
    expect(window.location.hash).toContain('turn=turn_m2');
    expect(screen.getByRole('button', { name: 'Follow latest' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    key('j');
    await waitFor(() => expect(current()).toMatch(/Busy sessions/));
    key('j');
    key('k');
    await waitFor(() => expect(current()).toMatch(/Research how a live viewer/));
  });

  it('focuses the session list’s search with /, showing the list when it is hidden', () => {
    const store = createStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    const search = () => screen.getByRole('searchbox', { name: 'Search title or folder' });
    key('/');
    expect(search()).toHaveFocus();
    // Hidden from the menu button: / shows it again, onto its search.
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Sessions' }));
    expect(screen.queryByRole('searchbox', { name: 'Search title or folder' })).toBeNull();
    key('/');
    expect(search()).toHaveFocus();
  });

  it('lists every shortcut under ?, and Esc closes the list', () => {
    render(<App store={createStore()} connect={noConnect} runs={fakeRuns()} />);
    key('?', { shiftKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const words of [
      'Jump to a session, prompt, page or action',
      'Search the session list',
      'Switch the session page’s tab',
      'Down / up the prompt list',
      'Go Home',
      'Go to the session page',
      'Go to Stats',
      'Show these shortcuts',
      'Close a dialog, the palette or this list',
    ])
      expect(dialog).toHaveTextContent(words);
    expect(
      [...dialog.querySelectorAll('dt')].map((dt) => dt.textContent?.replace(/\s+/g, ' ')),
    ).toEqual(['Ctrl K', '/', '1–5', 'j / k', 'g h', 'g s', 'g t', '?', 'Esc']);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('takes no keys typed in the composer', async () => {
    window.location.hash = demoLink;
    render(<App store={demoStore()} connect={noConnect} runs={fakeRuns()} />);
    const box = screen.getByRole('textbox', { name: /message/i });
    box.focus();
    key('2');
    key('g');
    key('h');
    expect(window.location.hash).toBe(demoLink);
  });
});

describe('App palette', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEMO_NOW);
    window.location.hash = '';
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.location.hash = '';
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });
  const demoLink = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
  const listed = () => {
    const store = createStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    return store;
  };
  /** Ctrl+K (⌘K on a Mac), then `query` typed; the field, in either language. */
  const jump = (query = '') => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'k', ctrlKey: true });
    const field = screen.getByRole('combobox', { name: /^(Jump to…|跳转到…)$/ });
    if (query) fireEvent.change(field, { target: { value: query } });
    return field;
  };
  /** The palette's options (the composer has a select of its own). */
  const options = () => {
    const list = screen.queryByRole('listbox', { name: 'Matches' });
    return list
      ? within(list)
          .getAllByRole('option')
          .map((o) => o.textContent)
      : [];
  };

  it('opens on Ctrl+K over the sessions, the pages, the tabs and the actions', () => {
    render(<App store={listed()} connect={noConnect} runs={fakeRuns()} />);
    jump();
    expect(screen.getByRole('dialog', { name: 'Jump to…' })).toBeInTheDocument();
    // The running session first; its dot says so.
    expect(options()).toEqual([
      'glassbox / Live viewer research (demo)Session',
      'shopfront / Fix flaky login testSession',
      'blog / Untitled sessionSession',
      'HomePage',
      'StatsPage',
      'Execution chainTab',
      'How it workedTab',
      'Where tokens wentTab',
      'TimelineTab',
      'FilesTab',
      'New sessionAction',
      'Switch to Chinese · 中文Action',
      'Theme: LightAction',
      'Theme: DarkAction',
      'Hide the session listAction',
      'Keyboard shortcutsAction',
    ]);
    expect(screen.getAllByRole('option')[0]).toContainElement(
      screen.getByRole('img', { name: 'Running' }),
    );
  });

  it('opens the session picked, closing itself', async () => {
    render(<App store={listed()} connect={noConnect} runs={fakeRuns()} />);
    const field = jump('flaky');
    expect(options()).toEqual(['shopfront / Fix flaky login testSession']);
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() =>
      expect(window.location.hash).toBe(
        `#/s/${encodeURIComponent('claude-code:demo-0000-4000-8000-000000000002')}`,
      ),
    );
    expect(screen.queryByRole('dialog', { name: 'Jump to…' })).toBeNull();
  });

  it('opens from Jump to… in the top bar too, and gives focus back to it', () => {
    render(<App store={listed()} connect={noConnect} runs={fakeRuns()} />);
    const button = within(screen.getByRole('banner')).getByRole('button', { name: 'Jump to…' });
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+K');
    button.focus();
    fireEvent.click(button);
    const field = screen.getByRole('combobox', { name: 'Jump to…' });
    expect(field).toHaveFocus();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Jump to…' })).toBeNull();
    expect(button).toHaveFocus();
  });

  it('selects one of the open session’s prompts, on the prompt list', async () => {
    window.location.hash = `${demoLink}?tab=time`;
    render(<App store={demoStore()} connect={noConnect} runs={fakeRuns()} />);
    const field = jump('prompt research');
    // As the prompt list words it, on one line; the row's end cuts what does not fit.
    expect(options()).toEqual([
      expect.stringMatching(
        /^Prompt 2 · Research how a live viewer could read Claude Code transcripts, use ultracode\. What I need .*…Prompt$/,
      ),
    ]);
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(window.location.hash).toBe(`${demoLink}?turn=turn_m2`));
    expect(screen.getByRole('button', { name: 'Follow latest' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('switches the language and the theme, hides the list and starts a new session', () => {
    render(<App store={listed()} connect={noConnect} runs={fakeRuns()} />);
    fireEvent.keyDown(jump('chinese'), { key: 'Enter' });
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
    fireEvent.keyDown(jump('english'), { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    fireEvent.keyDown(jump('dark'), { key: 'Enter' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    // The current theme is not offered again.
    jump('theme');
    expect(options()).toEqual(['Theme: LightAction', 'Theme: SystemAction']);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Jump to…' }), { key: 'Escape' });
    fireEvent.keyDown(jump('hide list'), { key: 'Enter' });
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).toBeNull();
    fireEvent.keyDown(jump('show list'), { key: 'Enter' });
    expect(screen.getByRole('navigation', { name: 'Sessions' })).toBeInTheDocument();
    fireEvent.keyDown(jump('new'), { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeInTheDocument();
  });

  it('prints the receipt of the session open, and offers none on Home', async () => {
    const { unmount } = render(<App store={listed()} connect={noConnect} runs={fakeRuns()} />);
    jump('receipt');
    expect(options()).toEqual([]);
    unmount();
    window.location.hash = demoLink;
    render(<App store={demoStore()} connect={noConnect} runs={fakeRuns()} />);
    fireEvent.keyDown(jump('receipt'), { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: 'Receipt' })).toBeInTheDocument();
  });

  it('lists the keyboard shortcuts from its actions', () => {
    render(<App store={listed()} connect={noConnect} runs={fakeRuns()} />);
    fireEvent.keyDown(jump('keyboard'), { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });
});

// F1: a background tab says how many sessions need you.
describe('documentTitle', () => {
  it('counts the sessions that need you, before the open session’s title', () => {
    expect(documentTitle(0, null)).toBe('glassbox');
    expect(documentTitle(2, null)).toBe('(2) glassbox');
    expect(documentTitle(0, 'Fix flaky login test')).toBe('Fix flaky login test · glassbox');
    expect(documentTitle(1, 'Fix flaky login test')).toBe('(1) Fix flaky login test · glassbox');
  });
});

describe('App document title', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEMO_NOW);
    window.location.hash = '';
  });
  afterEach(() => {
    vi.useRealTimers();
    window.location.hash = '';
    document.title = '';
  });

  const prompt = {
    id: 'tu_1',
    toolName: 'Bash',
    input: { command: 'ls' },
    questions: null,
    requestedAt: DEMO_NOW.toISOString(),
  };

  it('counts the sessions waiting for you, from prompts and from their own state, hidden probes aside', async () => {
    const store = createStore();
    const all = createDemoSessions(DEMO_NOW);
    const [demo, idle, closed] = all;
    if (!demo || !idle || !closed) throw new Error('fixture');
    store.applyEvent({ type: 'sessions', sessions: all });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    expect(document.title).toBe('glassbox');
    // A glassbox run's prompt.
    act(() =>
      store.applyEvent({
        type: 'run',
        run: runState({
          id: 'run_2',
          sessionId: idle.id,
          status: 'waiting-permission',
          pendingPermissions: [prompt],
        }),
      }),
    );
    expect(document.title).toBe('(1) glassbox');
    // A session a terminal holds, blocked on its own prompt; a probe waiting counts for nothing.
    act(() =>
      store.applyEvent({
        type: 'sessions',
        sessions: [
          demo,
          idle,
          { ...closed, live: 'waiting' },
          { ...closed, id: 'claude-code:probe', title: 'Probe', tags: ['probe'], live: 'waiting' },
        ],
      }),
    );
    expect(document.title).toBe('(2) glassbox');
    // On the session page, the session's title comes first.
    act(() => {
      window.location.hash = `#/s/${encodeURIComponent(idle.id)}`;
    });
    await waitFor(() => expect(document.title).toBe('(2) Fix flaky login test · glassbox'));
    // Answered, and the other one back to idle.
    act(() => {
      store.applyEvent({ type: 'run', run: runState({ id: 'run_2', sessionId: idle.id }) });
      store.applyEvent({ type: 'sessions', sessions: all });
    });
    expect(document.title).toBe('Fix flaky login test · glassbox');
    act(() => {
      window.location.hash = `#/s/${encodeURIComponent(closed.id)}`;
    });
    await waitFor(() => expect(document.title).toBe('Untitled session · glassbox'));
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

  it('opens onto its search with /, from the page behind it', () => {
    screenWidth(1024);
    window.location.hash = `#/s/${encodeURIComponent(DEMO_SESSION_ID)}`;
    render(<App store={demoStore()} connect={noConnect} />);
    expect(screen.queryByRole('dialog', { name: 'Sessions' })).toBeNull();
    fireEvent.keyDown(document.body, { key: '/' });
    const list = screen.getByRole('dialog', { name: 'Sessions' });
    expect(within(list).getByRole('searchbox')).toHaveFocus();
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

  // D4: Stats lays out as Home does; below 901 the list is the drawer, as everywhere.
  it('keeps the list as a column on Stats too, and the drawer below 901', () => {
    screenWidth(1024);
    window.location.hash = '#/stats';
    render(<App store={demoStore()} connect={noConnect} />);
    const list = screen.getByRole('navigation', { name: 'Sessions' });
    expect(list.closest('[data-sidebar-mode]')).toHaveAttribute('data-sidebar-mode', 'column');
    resize(768);
    expect(document.querySelector('[data-sidebar-mode]')).toHaveAttribute(
      'data-sidebar-mode',
      'drawer',
    );
  });

  it('closes the floating list when the page changes under it, Stats included', async () => {
    screenWidth(768);
    window.location.hash = '';
    render(<App store={demoStore()} connect={noConnect} />);
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Sessions' }));
    expect(screen.getByRole('dialog', { name: 'Sessions' })).toBeInTheDocument();
    act(() => {
      window.location.hash = '#/stats';
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sessions' })).toBeNull());
  });
});

// D4 part 1 (N1a): the top bar's page nav, Home · Session · Stats, and the routes behind it.
describe('App pages: Home · Session · Stats', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEMO_NOW);
    window.location.hash = '';
    // Stats reads the week: here it never answers.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  const at = (id: string) => `#/s/${encodeURIComponent(id)}`;
  const pages = () => within(screen.getByRole('banner')).getByRole('navigation', { name: 'Pages' });
  const page = (name: 'Home' | 'Session' | 'Stats') => within(pages()).getByRole('link', { name });
  const listed = (sessions = createDemoSessions(DEMO_NOW)) => {
    const store = createStore();
    store.applyEvent({ type: 'sessions', sessions });
    return store;
  };
  const [demo, idle] = createDemoSessions(DEMO_NOW);
  if (!demo || !idle) throw new Error('fixture');

  it('links the three pages after the wordmark, the current one marked; the wordmark goes Home', () => {
    window.location.hash = '#/stats';
    render(<App store={listed()} connect={noConnect} runs={fakeRuns()} />);
    expect(
      within(pages())
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Home', 'Session', 'Stats']);
    expect(page('Stats')).toHaveAttribute('aria-current', 'page');
    expect(page('Home')).not.toHaveAttribute('aria-current');
    expect(page('Home')).toHaveAttribute('href', '#/');
    const wordmark = within(screen.getByRole('banner')).getByRole('link', { name: 'glassbox' });
    expect(wordmark).toHaveAttribute('href', '#/');
  });

  it('goes Back and Forward across all three pages', async () => {
    window.location.hash = at(idle.id);
    render(<App store={listed()} connect={noConnect} runs={fakeRuns()} />);
    expect(page('Session')).toHaveAttribute('aria-current', 'page');
    fireEvent.click(page('Stats'));
    await waitFor(() => expect(page('Stats')).toHaveAttribute('aria-current', 'page'));
    // Its own chunk, loaded on the first visit.
    expect(await screen.findByRole('heading', { name: 'Stats' })).toBeInTheDocument();
    fireEvent.click(page('Home'));
    await waitFor(() => expect(page('Home')).toHaveAttribute('aria-current', 'page'));
    act(() => history.back());
    await waitFor(() => expect(window.location.hash).toBe('#/stats'));
    act(() => history.back());
    await waitFor(() => expect(page('Session')).toHaveAttribute('aria-current', 'page'));
    expect(window.location.hash).toBe(at(idle.id));
    act(() => history.forward());
    await waitFor(() => expect(page('Stats')).toHaveAttribute('aria-current', 'page'));
  });

  it('switches the window in place: the entry is replaced, so Back leaves the page', async () => {
    window.location.hash = '#/';
    window.location.hash = '#/stats';
    render(<App store={listed()} connect={noConnect} runs={fakeRuns()} />);
    const windows = await screen.findByRole('radiogroup', { name: 'Window' });
    expect(within(windows).getByRole('radio', { name: 'This week' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const entries = history.length;
    fireEvent.click(within(windows).getByRole('radio', { name: 'Last 7 days' }));
    await waitFor(() => expect(window.location.hash).toBe('#/stats?window=7d'));
    expect(history.length).toBe(entries);
    expect(
      within(screen.getByRole('radiogroup', { name: 'Window' })).getByRole('radio', {
        name: 'Last 7 days',
      }),
    ).toHaveAttribute('aria-checked', 'true');
    act(() => history.back());
    await waitFor(() => expect(page('Home')).toHaveAttribute('aria-current', 'page'));
  });

  it('takes Session back to the session page as it was left: tab, turn, request and card', async () => {
    const left = `${at(idle.id)}?tab=steps&turn=t1&req=r1&card=response`;
    window.location.hash = left;
    render(<App store={listed()} connect={noConnect} runs={fakeRuns()} />);
    fireEvent.click(page('Home'));
    await waitFor(() => expect(page('Home')).toHaveAttribute('aria-current', 'page'));
    expect(page('Session')).toHaveAttribute('href', left);
    fireEvent.click(page('Stats'));
    await waitFor(() => expect(page('Stats')).toHaveAttribute('aria-current', 'page'));
    fireEvent.click(page('Session'));
    await waitFor(() => expect(window.location.hash).toBe(left));
  });

  it('opens the most recently active session when none was opened, or the last one is gone', async () => {
    const all = createDemoSessions(DEMO_NOW);
    const store = listed(all);
    window.location.hash = at(idle.id);
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    fireEvent.click(page('Home'));
    await waitFor(() => expect(page('Session')).toHaveAttribute('href', at(idle.id)));
    act(() =>
      store.applyEvent({ type: 'sessions', sessions: all.filter((s) => s.id !== idle.id) }),
    );
    expect(page('Session')).toHaveAttribute('href', at(demo.id));
  });

  it('points Session at the most recently active session on a fresh load', () => {
    render(<App store={listed()} connect={noConnect} runs={fakeRuns()} />);
    expect(page('Session')).toHaveAttribute('href', at(demo.id));
    expect(page('Session')).not.toHaveAttribute('aria-disabled');
  });

  it('carries the amber dot while the session it opens waits for you', () => {
    const store = listed();
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    expect(page('Session')).not.toHaveAccessibleDescription('Waiting for you');
    expect(page('Session').querySelector('[data-waiting]')).toBeNull();
    act(() =>
      store.applyEvent({
        type: 'run',
        run: runState({
          status: 'waiting-permission',
          pendingPermissions: [
            {
              id: 'tu_1',
              toolName: 'Bash',
              input: { command: 'ls' },
              questions: null,
              requestedAt: DEMO_NOW.toISOString(),
            },
          ],
        }),
      }),
    );
    expect(page('Session')).toHaveAccessibleDescription('Waiting for you');
    expect(page('Session').querySelector('[data-waiting]')).not.toBeNull();
  });

  it('makes Session unavailable, saying why, on a machine with no sessions', () => {
    render(<App store={listed([])} connect={noConnect} runs={fakeRuns()} />);
    const item = page('Session');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('title', 'No sessions yet');
    expect(item).not.toHaveAttribute('href');
    // Reachable from the keyboard, so the reason is read out as well as shown on hover.
    // The attribute itself: an <a> reports a tabIndex of 0 without one, and is not focusable then.
    expect(item).toHaveAttribute('tabindex', '0');
    fireEvent.click(item);
    expect(window.location.hash).toBe('');
  });

  it('keeps Session on the session left while the list has not arrived to say it is gone', async () => {
    const left = `${at(idle.id)}?tab=time`;
    window.location.hash = left;
    render(<App store={createStore()} connect={noConnect} runs={fakeRuns()} />);
    fireEvent.click(page('Home'));
    await waitFor(() => expect(page('Home')).toHaveAttribute('aria-current', 'page'));
    expect(page('Session')).toHaveAttribute('href', left);
    expect(page('Session')).not.toHaveAttribute('aria-disabled');
  });

  it('does not say there are no sessions before the list has arrived', () => {
    render(<App store={createStore()} connect={noConnect} runs={fakeRuns()} />);
    expect(page('Session')).toHaveAttribute('aria-disabled', 'true');
    expect(page('Session')).toHaveAttribute('title', 'Reading local sessions…');
  });

  // F1: the composer had nothing to send to on Home ("Pick a session first"); the board's header
  // offers New session instead, and the composer appears with the session.
  it('shows no composer on Home, only on the session page', async () => {
    render(<App store={listed()} connect={noConnect} runs={fakeRuns()} />);
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(document.getElementById('composer-slot')).toBeEmptyDOMElement();
    expect(screen.getAllByRole('button', { name: 'New session' })).toHaveLength(1);
    fireEvent.click(within(sidebar()).getByRole('button', { name: /Fix flaky login test/ }));
    await waitFor(() => expect(page('Session')).toHaveAttribute('aria-current', 'page'));
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });

  it('shows no composer on Stats, and opens a session picked from the list there', async () => {
    window.location.hash = '#/stats';
    render(<App store={listed()} connect={noConnect} runs={fakeRuns()} />);
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(document.getElementById('composer-slot')).toBeEmptyDOMElement();
    fireEvent.click(within(sidebar()).getByRole('button', { name: /Fix flaky login test/ }));
    expect(window.location.hash).toBe(at(idle.id));
    // Browsers (and jsdom) deliver hashchange asynchronously.
    await waitFor(() => expect(page('Session')).toHaveAttribute('aria-current', 'page'));
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });

  it('speaks Chinese: 首页 · 会话 · 统计', async () => {
    localStorage.setItem('glassbox.prefs', JSON.stringify({ locale: 'zh' }));
    onTestFinished(() => localStorage.clear());
    window.location.hash = '#/stats';
    render(<App store={listed([])} connect={noConnect} runs={fakeRuns()} />);
    const nav = within(screen.getByRole('banner')).getByRole('navigation', { name: '页面' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['首页', '会话', '统计']);
    expect(within(nav).getByRole('link', { name: '会话' })).toHaveAttribute('title', '还没有会话');
    const windows = await screen.findByRole('radiogroup', { name: '时间范围' });
    expect(
      within(windows)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['本周', '最近 7 天']);
  });
});

// Branch D (F7): the list's grouping, folds and pins live in the prefs, so they survive a reload.
describe('App session list prefs', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEMO_NOW);
    window.location.hash = '';
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    window.location.hash = '';
  });

  it('lists as the saved prefs say, and saves a change to them', () => {
    const [, idle] = createDemoSessions(DEMO_NOW);
    localStorage.setItem(
      'glassbox.prefs',
      JSON.stringify({ groupBy: 'time', pinned: [idle?.id], folded: ['/today'] }),
    );
    const store = createStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(DEMO_NOW) });
    render(<App store={store} connect={noConnect} runs={fakeRuns()} />);
    const list = sidebar();
    expect(
      within(list)
        .getAllByRole('list')
        .map((l) => l.getAttribute('aria-label')),
    ).toEqual(['Pinned', 'This week']);
    expect(within(list).getByRole('button', { name: /^Today/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    fireEvent.click(within(list).getByRole('radio', { name: 'Project' }));
    const saved = JSON.parse(localStorage.getItem('glassbox.prefs') ?? '{}');
    expect(saved).toMatchObject({ groupBy: 'project', pinned: [idle?.id], folded: ['/today'] });
  });
});

// Branch D (F7) item 6: early in the week the nav's Stats link opens the last 7 days, and the
// page says why, once. `#/stats` itself keeps meaning this week.
describe('App Stats default window', () => {
  // A Monday afternoon, local time.
  const MONDAY = new Date(2026, 9, 26, 14, 0, 0);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    window.location.hash = '';
    // Stats reads the week: here it never answers.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
    window.location.hash = '';
  });
  const pages = () => within(screen.getByRole('banner')).getByRole('navigation', { name: 'Pages' });
  const stats = () => within(pages()).getByRole('link', { name: 'Stats' });
  const note = /Less than a day into the week/;

  it('points Stats at the last 7 days while the week is under a day old, and notes why once', async () => {
    vi.setSystemTime(MONDAY);
    render(<App store={createStore()} connect={noConnect} runs={fakeRuns()} />);
    expect(stats()).toHaveAttribute('href', '#/stats?window=7d');
    fireEvent.click(stats());
    await waitFor(() => expect(window.location.hash).toBe('#/stats?window=7d'));
    expect(await screen.findByText(note)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('glassbox.prefs') ?? '{}').statsNoteSeen).toBe(true);
    // Said once: the next visit does without it.
    fireEvent.click(within(pages()).getByRole('link', { name: 'Home' }));
    await waitFor(() =>
      expect(within(pages()).getByRole('link', { name: 'Home' })).toHaveAttribute(
        'aria-current',
        'page',
      ),
    );
    fireEvent.click(stats());
    await screen.findByRole('radiogroup', { name: 'Window' });
    expect(screen.queryByText(note)).toBeNull();
  });

  it('keeps #/stats meaning this week, without the note; later in the week the link says so too', async () => {
    vi.setSystemTime(MONDAY);
    window.location.hash = '#/stats';
    const first = render(<App store={createStore()} connect={noConnect} runs={fakeRuns()} />);
    const windows = await screen.findByRole('radiogroup', { name: 'Window' });
    expect(within(windows).getByRole('radio', { name: 'This week' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.queryByText(note)).toBeNull();
    first.unmount();
    // A Friday.
    vi.setSystemTime(DEMO_NOW);
    window.location.hash = '';
    render(<App store={createStore()} connect={noConnect} runs={fakeRuns()} />);
    expect(stats()).toHaveAttribute('href', '#/stats');
  });
});
