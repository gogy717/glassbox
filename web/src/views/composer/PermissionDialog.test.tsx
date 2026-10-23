import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '../../../../src/shared/runs.js';
import { I18nContext, makeI18n } from '../../i18n';
import { PermissionDialog } from './PermissionDialog';

const bash: PermissionRequest = {
  id: 'tu_1',
  toolName: 'Bash',
  input: { command: 'rm -rf build', description: 'Clean the build folder' },
  questions: null,
  requestedAt: '2026-10-23T10:00:00.000Z',
};

const ask: PermissionRequest = {
  id: 'tu_2',
  toolName: 'AskUserQuestion',
  input: {},
  questions: [
    {
      question: 'Which database?',
      header: 'DB',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: 'Relational' },
        { label: 'SQLite', description: 'Embedded' },
      ],
    },
    {
      question: 'Which features?',
      header: 'Features',
      multiSelect: true,
      options: [
        { label: 'Auth', description: '' },
        { label: 'Search', description: '' },
        { label: 'Billing', description: '' },
      ],
    },
  ],
  requestedAt: '2026-10-23T10:00:00.000Z',
};

function renderDialog(
  request: PermissionRequest,
  onDecide = vi.fn(async () => {}),
  onDismiss = vi.fn(),
) {
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <button type="button">page behind</button>
      <PermissionDialog request={request} onDecide={onDecide} onDismiss={onDismiss} />
    </I18nContext.Provider>,
  );
  return onDecide;
}

describe('PermissionDialog', () => {
  it('takes focus and keeps Tab inside the prompt', () => {
    renderDialog(bash);
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    const allow = screen.getByRole('button', { name: 'Allow' });
    allow.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole('button', { name: 'page behind' })).not.toHaveFocus();
  });

  it('collapses on Escape without answering', () => {
    const onDecide = vi.fn(async () => {});
    const onDismiss = vi.fn();
    renderDialog(bash, onDecide, onDismiss);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('shows the tool and what it wants to do, and allows it', async () => {
    const onDecide = renderDialog(bash);
    const dialog = screen.getByRole('dialog', { name: 'Claude Code wants to use Bash' });
    expect(dialog).toHaveTextContent('rm -rf build');
    expect(dialog).toHaveTextContent('Clean the build folder');
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith({ decision: 'allow' }));
  });

  it('denies with an optional reason for the model', async () => {
    const onDecide = renderDialog(bash);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason (optional)' }), {
      target: { value: 'not now' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith({ decision: 'deny', message: 'not now' }),
    );
  });

  it('answers AskUserQuestion, single and multi select, once every question has an answer', async () => {
    const onDecide = renderDialog(ask);
    const submit = screen.getByRole('button', { name: 'Send answers' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Postgres/ }));
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Auth/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Search/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Search/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Billing/ }));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith({
        decision: 'allow',
        answers: { 'Which database?': 'Postgres', 'Which features?': ['Auth', 'Billing'] },
      }),
    );
  });

  it('locks the buttons while the answer is being sent and shows a failure', async () => {
    let fail: (e: Error) => void = () => {};
    const onDecide = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    renderDialog(bash, onDecide);
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
    fail(new Error('run is gone'));
    expect(await screen.findByText('Could not send: run is gone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
  });
});
