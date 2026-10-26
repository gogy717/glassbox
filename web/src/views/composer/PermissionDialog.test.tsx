import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '../../../../src/shared/runs.js';
import { StoreContext } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import { demoStore } from '../../test/demo';
import { PermissionDialog, PROMPT_ARM_MS } from './PermissionDialog';

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
      <PermissionDialog request={request} onDecide={onDecide} onDismiss={onDismiss} armMs={0} />
    </I18nContext.Provider>,
  );
  return onDecide;
}

/** As in App: answering drops the prompt at once, and the next queued one mounts in place. */
function Queue({
  requests,
  onDecided,
}: {
  requests: PermissionRequest[];
  onDecided(id: string, decision: string): void;
}) {
  const [queue, setQueue] = useState(requests);
  const head = queue[0];
  if (!head) return null;
  return (
    <PermissionDialog
      key={head.id}
      request={head}
      onDecide={(d) => {
        onDecided(head.id, d.decision);
        setQueue((q) => q.slice(1));
      }}
    />
  );
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

  it('skips a question rather than denying it', async () => {
    const onDecide = renderDialog(ask);
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith({ decision: 'deny' }));
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

  it('names the prompt, where its call sits, and the keys, as a quiet panel', () => {
    const store = demoStore();
    const open = store.getState().open;
    const call = open?.toolCalls.get('tu_m2a');
    const request = call ? open?.requests.get(call.requestId) : undefined;
    const turn = request?.turnId ? open?.turns.get(request.turnId) : undefined;
    expect(turn && request).toBeTruthy();
    render(
      <StoreContext.Provider value={store}>
        <I18nContext.Provider value={makeI18n('en')}>
          <PermissionDialog request={{ ...bash, id: 'tu_m2a' }} onDecide={vi.fn()} armMs={0} />
        </I18nContext.Provider>
      </StoreContext.Provider>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Claude Code wants to use Bash' });
    expect(dialog).toHaveTextContent(`Prompt ${turn?.index} · call #${request?.index}`);
    expect(dialog).toHaveTextContent('Permission');
    expect(dialog).toHaveTextContent('Esc hides this prompt; it stays pending');
  });

  it('leaves the reference out when the call is not in the records yet', () => {
    renderDialog(bash);
    expect(screen.getByRole('dialog')).not.toHaveTextContent(/Prompt \d/);
  });

  it('starts with focus on the panel itself, where Enter answers nothing', () => {
    const onDecide = renderDialog(bash);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Enter' });
    fireEvent.keyPress(dialog, { key: 'Enter', charCode: 13 });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('ignores its buttons for a moment after it appears, so a double-click answers one prompt', () => {
    vi.useFakeTimers();
    try {
      const second: PermissionRequest = { ...bash, id: 'tu_9', input: { command: 'rm -rf /' } };
      const decided: string[] = [];
      render(
        <I18nContext.Provider value={makeI18n('en')}>
          <Queue requests={[bash, second]} onDecided={(id, d) => decided.push(`${id}:${d}`)} />
        </I18nContext.Provider>,
      );
      // Inert, and drawn so, until it has been there PROMPT_ARM_MS.
      expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
      act(() => vi.advanceTimersByTime(PROMPT_ARM_MS));
      const allow = screen.getByRole('button', { name: 'Allow' });
      expect(allow).toBeEnabled();
      // A double-click: the second click lands on the next prompt's Allow, in the same place.
      act(() => {
        fireEvent.click(allow);
      });
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
      });
      expect(decided).toEqual(['tu_1:allow']);
      expect(screen.getByText('rm -rf /')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(PROMPT_ARM_MS));
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
      });
      expect(decided).toEqual(['tu_1:allow', 'tu_9:allow']);
    } finally {
      vi.useRealTimers();
    }
  });
});
