import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RunState } from '../../../../src/shared/runs.js';
import { ApiError } from '../../data/api';
import type { RunsClient } from '../../data/runs';
import { I18nContext, makeI18n } from '../../i18n';
import { NewSessionDialog } from './NewSessionDialog';

const run = { id: 'run_1', sessionId: null, status: 'starting' } as unknown as RunState;

function fakeClient(over: Partial<RunsClient> = {}): RunsClient {
  return {
    token: vi.fn(async () => 't'),
    start: vi.fn(async () => run),
    send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    decide: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    directories: vi.fn(async () => ['/Users/demo/Dev/glassbox', '/Users/demo/Dev/blog']),
    ...over,
  };
}

function renderDialog(client = fakeClient(), onStarted = vi.fn()) {
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <NewSessionDialog client={client} onStarted={onStarted} onClose={() => {}} />
    </I18nContext.Provider>,
  );
  return { client, onStarted };
}

describe('NewSessionDialog', () => {
  it('uses a compact dialog for a short form', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'New session' })).toHaveAttribute(
      'data-size',
      'compact',
    );
  });

  it('offers recent directories whole when they fit, picked with a click', async () => {
    renderDialog();
    const chip = await screen.findByRole('button', { name: '/Users/demo/Dev/blog' });
    expect(chip).not.toHaveAccessibleDescription();
    fireEvent.click(chip);
    expect(screen.getByRole('textbox', { name: 'Working directory' })).toHaveValue(
      '/Users/demo/Dev/blog',
    );
  });

  it('cuts a long directory in the middle, keeping its root and its tail, the whole on hover', async () => {
    const long = '/home/user/orca/workspaces/glassbox/anemone';
    renderDialog(fakeClient({ directories: vi.fn(async () => [long]) }));
    const chip = await screen.findByRole('button', { name: '/…/workspaces/glassbox/anemone' });
    expect(chip).toHaveAccessibleDescription(long);
    fireEvent.click(chip);
    expect(screen.getByRole('textbox', { name: 'Working directory' })).toHaveValue(long);
  });

  it('keeps temporary folders out of the way until asked for', async () => {
    renderDialog(
      fakeClient({
        directories: vi.fn(async () => ['/Users/demo/Dev/blog', '/private/tmp/claude-501/scratch']),
      }),
    );
    await screen.findByRole('button', { name: '/Users/demo/Dev/blog' });
    expect(screen.queryByRole('button', { name: '/private/tmp/claude-501/scratch' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Temporary folders (1)' }));
    expect(
      screen.getByRole('button', { name: '/private/tmp/claude-501/scratch' }),
    ).toBeInTheDocument();
  });

  it('needs an absolute directory and a first message before starting', async () => {
    renderDialog();
    const start = screen.getByRole('button', { name: 'Start' });
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), {
      target: { value: 'Dev/x' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'First message' }), {
      target: { value: 'hi' },
    });
    expect(screen.getByText('Use an absolute path')).toBeInTheDocument();
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), {
      target: { value: '/w/x' },
    });
    expect(start).toBeEnabled();
  });

  it('starts a new run with the chosen permission mode and reports it', async () => {
    const { client, onStarted } = renderDialog();
    fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), {
      target: { value: '/w/x' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'First message' }), {
      target: { value: '  hi  ' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Permissions' }), {
      target: { value: 'plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(run));
    expect(client.start).toHaveBeenCalledWith({
      mode: 'new',
      cwd: '/w/x',
      prompt: 'hi',
      permissionMode: 'plan',
    });
  });

  it('shows why a run could not start', async () => {
    const client = fakeClient({
      start: vi.fn(async () =>
        Promise.reject(new ApiError(503, 'The claude command was not found')),
      ),
    });
    renderDialog(client);
    fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), {
      target: { value: '/w/x' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'First message' }), {
      target: { value: 'hi' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(
      await screen.findByText('Could not start: The claude command was not found'),
    ).toBeInTheDocument();
  });
});
