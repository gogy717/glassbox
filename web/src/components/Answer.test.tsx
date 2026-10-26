import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../../../src/core/model.js';
import type { PermissionRequest } from '../../../src/shared/runs.js';
import { I18nContext, makeI18n } from '../i18n';
import { Answer } from './Answer';

const session: SessionSummary = {
  id: 'claude-code:s1',
  agent: 'claude-code',
  nativeId: 's1',
  title: 'Plant the beds',
  cwd: '/w/garden',
  project: 'garden',
  startedAt: '2026-10-26T09:00:00.000Z',
  updatedAt: '2026-10-26T09:59:00.000Z',
  live: 'waiting',
  version: null,
  model: null,
  usage: null,
  counts: null,
};

const question: PermissionRequest = {
  id: 'tu_2',
  toolName: 'AskUserQuestion',
  input: {},
  questions: [
    {
      question: 'Which beds first?',
      header: 'Beds',
      multiSelect: false,
      options: [
        { label: 'North', description: 'In the sun' },
        { label: 'South', description: '' },
      ],
    },
  ],
  requestedAt: '2026-10-26T09:59:00.000Z',
};

const plan: PermissionRequest = {
  id: 'tu_3',
  toolName: 'ExitPlanMode',
  input: { plan: '## Plan\n\n1. Split the parser\n2. Add the tests' },
  questions: null,
  requestedAt: '2026-10-26T09:59:00.000Z',
};

const bash: PermissionRequest = {
  id: 'tu_1',
  toolName: 'Bash',
  input: { command: 'git push origin main' },
  questions: null,
  requestedAt: '2026-10-26T09:59:00.000Z',
};

function renderAnswer(
  request: PermissionRequest,
  more: { armed?: boolean; locale?: 'en' | 'zh' } = {},
) {
  const onDecide = vi.fn(async () => {});
  const onOpen = vi.fn();
  render(
    <I18nContext.Provider value={makeI18n(more.locale ?? 'en')}>
      <Answer
        session={session}
        prompt={{ runId: 'run_7', request }}
        armed={more.armed ?? true}
        inline
        onDecide={onDecide}
        onOpen={onOpen}
      />
    </I18nContext.Provider>,
  );
  return { onDecide, onOpen };
}

describe('Answer, inline (the Inbox)', () => {
  it('answers a question with the dialog’s own controls, its keys on its buttons', async () => {
    const { onDecide } = renderAnswer(question);
    const group = screen.getByRole('group', { name: 'Question · Plant the beds' });
    const send = within(group).getByRole('button', { name: 'Send answers' });
    const skip = within(group).getByRole('button', { name: 'Skip' });
    expect(send).toHaveAttribute('aria-keyshortcuts', 'y');
    expect(skip).toHaveAttribute('aria-keyshortcuts', 'n');
    // Esc does not hide anything here: the dialog's word about it stays in the dialog.
    expect(group).not.toHaveTextContent('Esc');
    expect(send).toBeDisabled();
    fireEvent.click(within(group).getByRole('radio', { name: /North/ }));
    fireEvent.click(send);
    await act(async () => {});
    expect(onDecide).toHaveBeenCalledWith('run_7', 'tu_2', {
      decision: 'allow',
      answers: { 'Which beds first?': 'North' },
    });
    // Sent: nothing more to press until the item moves on.
    expect(skip).toBeDisabled();
  });

  it('skips a question, which denies it', async () => {
    const { onDecide } = renderAnswer(question);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await act(async () => {});
    expect(onDecide).toHaveBeenCalledWith('run_7', 'tu_2', { decision: 'deny' });
  });

  it('shows a plan whole, and approves or rejects it', async () => {
    const { onDecide } = renderAnswer(plan);
    const group = screen.getByRole('group', { name: 'Plan to approve · Plant the beds' });
    expect(group).toHaveTextContent('Split the parser');
    expect(group).toHaveTextContent('Add the tests');
    const approve = within(group).getByRole('button', { name: 'Approve' });
    expect(approve).toHaveAttribute('aria-keyshortcuts', 'y');
    expect(approve).toHaveAttribute('data-kind', 'primary');
    expect(within(group).getByRole('button', { name: 'Reject' })).toHaveAttribute(
      'aria-keyshortcuts',
      'n',
    );
    expect(within(group).queryByRole('button', { name: 'Open' })).toBeNull();
    fireEvent.click(approve);
    await act(async () => {});
    expect(onDecide).toHaveBeenCalledWith('run_7', 'tu_3', { decision: 'allow' });
  });

  it('rejects a plan, which denies it', async () => {
    const { onDecide } = renderAnswer(plan);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await act(async () => {});
    expect(onDecide).toHaveBeenCalledWith('run_7', 'tu_3', { decision: 'deny' });
  });

  it('allows and denies a tool with the keys on its buttons', () => {
    renderAnswer(bash);
    const group = screen.getByRole('group', { name: 'Permission for Bash · Plant the beds' });
    expect(within(group).getByRole('button', { name: 'Allow' })).toHaveAttribute(
      'aria-keyshortcuts',
      'y',
    );
    expect(within(group).getByRole('button', { name: 'Deny' })).toHaveAttribute(
      'aria-keyshortcuts',
      'n',
    );
  });

  it('keeps every answer inert until armed', () => {
    for (const request of [question, plan, bash]) {
      const { unmount } = render(
        <I18nContext.Provider value={makeI18n('en')}>
          <Answer
            session={session}
            prompt={{ runId: 'run_7', request }}
            armed={false}
            inline
            onDecide={vi.fn()}
            onOpen={vi.fn()}
          />
        </I18nContext.Provider>,
      );
      for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
      unmount();
    }
  });

  it('words a plan’s answers in Chinese', () => {
    renderAnswer(plan, { locale: 'zh' });
    expect(screen.getByRole('button', { name: '批准' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '驳回' })).toBeInTheDocument();
  });
});

describe('Answer, on a row (Home)', () => {
  it('keeps Open for a question and a plan, and no keys on its buttons', () => {
    for (const request of [question, plan]) {
      const { unmount } = render(
        <I18nContext.Provider value={makeI18n('en')}>
          <Answer
            session={session}
            prompt={{ runId: 'run_7', request }}
            armed
            onDecide={vi.fn()}
            onOpen={vi.fn()}
          />
        </I18nContext.Provider>,
      );
      expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Open']);
      unmount();
    }
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <Answer
          session={session}
          prompt={{ runId: 'run_7', request: bash }}
          armed
          onDecide={vi.fn()}
          onOpen={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    for (const b of screen.getAllByRole('button'))
      expect(b).not.toHaveAttribute('aria-keyshortcuts');
  });
});
