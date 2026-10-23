import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoSessions } from '../../../../src/core/fixtures/demo.js';
import type { SessionSummary } from '../../../../src/core/model.js';
import type { RunState } from '../../../../src/shared/runs.js';
import { ApiError } from '../../data/api';
import type { RunsClient } from '../../data/runs';
import { I18nContext, makeI18n } from '../../i18n';
import { DEMO_NOW } from '../../test/demo';
import { Composer } from './Composer';

const [busy, idle, closed] = createDemoSessions(DEMO_NOW) as [
  SessionSummary,
  SessionSummary,
  SessionSummary,
];

const runOf = (over: Partial<RunState>): RunState => ({
  id: 'run_1',
  sessionId: closed.id,
  cwd: '/w',
  mode: 'resume',
  status: 'idle',
  permissionMode: 'default',
  startedAt: DEMO_NOW.toISOString(),
  updatedAt: DEMO_NOW.toISOString(),
  pendingPermissions: [],
  partial: null,
  error: null,
  last: null,
  ...over,
});

function fakeClient(over: Partial<RunsClient> = {}): RunsClient {
  return {
    token: vi.fn(async () => 't'),
    start: vi.fn(async () => runOf({ status: 'starting' })),
    send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    decide: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    directories: vi.fn(async () => []),
    ...over,
  };
}

function renderComposer(props: {
  session: SessionSummary | null;
  run?: RunState | null;
  client?: RunsClient;
}) {
  const client = props.client ?? fakeClient();
  const onNewSession = vi.fn();
  const onRunStarted = vi.fn();
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <Composer
        session={props.session}
        run={props.run ?? null}
        client={client}
        onNewSession={onNewSession}
        onRunStarted={onRunStarted}
      />
    </I18nContext.Provider>,
  );
  return {
    client,
    onNewSession,
    onRunStarted,
    box: screen.getByRole('textbox', { name: 'Message' }),
  };
}

const type = (box: HTMLElement, value: string) => fireEvent.change(box, { target: { value } });

describe('Composer', () => {
  it('keeps another agent’s session view-only and points to a new Claude Code session', () => {
    const { box, client, onNewSession } = renderComposer({ session: { ...closed, agent: 'grok' } });
    expect(box).toBeDisabled();
    // Nothing to choose for an agent glassbox cannot run: the modes are not there at all.
    expect(screen.queryByRole('radiogroup', { name: 'How to send' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(box).toHaveAttribute(
      'placeholder',
      'Grok sessions are view-only; start a Claude Code session with “New session”',
    );
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    // Nothing will be sent from here, so there is no permission mode to pick.
    expect(screen.queryByRole('combobox', { name: 'Permissions' })).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(client.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(onNewSession).toHaveBeenCalled();
  });

  it('continues a closed session in place on Enter', async () => {
    const { client, onRunStarted, box } = renderComposer({ session: closed });
    expect(screen.getByRole('radio', { name: 'Continue' })).toHaveAttribute('aria-checked', 'true');
    type(box, 'next step please');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(onRunStarted).toHaveBeenCalled());
    expect(client.start).toHaveBeenCalledWith({
      mode: 'resume',
      sessionId: closed.id,
      prompt: 'next step please',
      permissionMode: 'default',
    });
    expect(box).toHaveValue('');
  });

  it('continues a session a terminal has open in a copy, saying once why', async () => {
    const { client, box } = renderComposer({ session: busy });
    expect(box).toBeEnabled();
    expect(box).toHaveAttribute(
      'placeholder',
      'Message Claude Code (Enter to send, Shift+Enter for a new line)',
    );
    expect(screen.getByRole('radio', { name: 'Continue in a copy' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Continue stays in view, struck through, with its reason; it is not a choice right now.
    const resume = screen.getByRole('radio', { name: 'Continue' });
    expect(resume).toBeDisabled();
    expect(resume).toHaveAttribute('title', expect.stringMatching(/^Open in a terminal right now/));
    expect(screen.getAllByText(/Open in a terminal right now/)).toHaveLength(1);
    type(box, 'hi');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(client.start).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'fork', sessionId: busy.id }),
      ),
    );
  });

  it('treats an idle terminal session as open too, and offers Continue again once it closes', () => {
    const client = fakeClient();
    const view = (session: SessionSummary) => (
      <I18nContext.Provider value={makeI18n('en')}>
        <Composer
          session={session}
          run={null}
          client={client}
          onNewSession={vi.fn()}
          onRunStarted={vi.fn()}
        />
      </I18nContext.Provider>
    );
    const { rerender } = render(view(idle));
    expect(screen.getByRole('radio', { name: 'Continue in a copy' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText(/Open in a terminal right now/)).toBeInTheDocument();
    rerender(view({ ...idle, live: 'closed' }));
    expect(screen.getByRole('radio', { name: 'Continue' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Continue' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText(/Open in a terminal right now/)).toBeNull();
  });

  it('keeps the person’s own pick for a closed session', () => {
    renderComposer({ session: closed });
    fireEvent.click(screen.getByRole('radio', { name: 'Continue in a copy' }));
    expect(screen.getByRole('radio', { name: 'Continue in a copy' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('keeps Shift+Enter and IME composition as typing; Ctrl/⌘+Enter also sends', async () => {
    const { client, box } = renderComposer({ session: closed });
    type(box, 'line one');
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    expect(client.start).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(1));
  });

  it('sends a follow-up to an idle run of this session', async () => {
    const { client, box } = renderComposer({ session: closed, run: runOf({}) });
    expect(screen.queryByRole('radio', { name: 'Continue' })).toBeNull();
    type(box, 'more');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(client.send).toHaveBeenCalledWith('run_1', 'more'));
  });

  it('waits while the run is replying, and can stop it', async () => {
    const { client, box } = renderComposer({ session: closed, run: runOf({ status: 'running' }) });
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute('placeholder', 'Waiting for the reply to finish');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(client.interrupt).toHaveBeenCalledWith('run_1'));
  });

  it('after a run failed, offers to start over in a copy with the typed message', async () => {
    const { client, box } = renderComposer({
      session: closed,
      run: runOf({ status: 'error', error: 'claude exited with code 1' }),
    });
    expect(screen.getByText('claude exited with code 1')).toBeInTheDocument();
    const restart = screen.getByRole('button', { name: 'Start over (copy)' });
    expect(restart).toBeDisabled();
    type(box, 'try again');
    fireEvent.click(restart);
    await waitFor(() =>
      expect(client.start).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'fork', sessionId: closed.id, prompt: 'try again' }),
      ),
    );
  });

  it('opens the new-session dialog, also when no session is open', () => {
    const { onNewSession, box } = renderComposer({ session: null });
    expect(box).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(onNewSession).toHaveBeenCalled();
  });

  it('keeps the message and explains when sending fails', async () => {
    const client = fakeClient({
      send: vi.fn(async () => Promise.reject(new ApiError(409, 'run is busy'))),
    });
    const { box } = renderComposer({ session: closed, run: runOf({}), client });
    type(box, 'keep me');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('Could not send: run is busy')).toBeInTheDocument();
    expect(box).toHaveValue('keep me');
  });
});
