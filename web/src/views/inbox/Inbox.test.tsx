import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionActivity, SessionSummary, TroubleSignal } from '../../../../src/core/model.js';
import type { PermissionRequest } from '../../../../src/shared/runs.js';
import type { OpenPrompt } from '../../data/runs';
import { I18nContext, makeI18n } from '../../i18n';
import { PROMPT_ARM_MS } from '../composer/PermissionDialog';
import { Inbox } from './Inbox';

const NOW = Date.parse('2026-10-26T10:00:00.000Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

let n = 0;
function session(live: SessionSummary['live'], more: Partial<SessionSummary> = {}): SessionSummary {
  n++;
  return {
    id: `claude-code:s${n}`,
    agent: 'claude-code',
    nativeId: `s${n}`,
    title: `Session ${n}`,
    cwd: '/w/garden',
    project: 'garden',
    startedAt: ago(7200),
    updatedAt: ago(600),
    live,
    version: null,
    model: null,
    usage: null,
    counts: null,
    ...more,
  };
}
const waitingOn = (
  tool: string | null,
  s: number,
  target: string | null = null,
): SessionActivity => ({
  kind: 'waiting',
  tool,
  target,
  agentId: 'main',
  since: ago(s),
});
const sign = (kind: TroubleSignal['kind'], s: number): TroubleSignal => ({
  kind,
  params: { x: 'npm test', n: 4 },
  at: null,
  since: ago(s),
});
function ask(id: string, toolName: string, s: number, input: unknown = {}): PermissionRequest {
  return {
    id,
    toolName,
    input,
    questions:
      toolName === 'AskUserQuestion'
        ? [
            {
              question: 'Which beds first?',
              header: 'Beds',
              multiSelect: false,
              options: [
                { label: 'North', description: 'In the sun' },
                { label: 'South', description: '' },
              ],
            },
          ]
        : null,
    requestedAt: ago(s),
  };
}

/** A session waiting on a glassbox run's prompt, as App lists it (`withWaiting`). */
function held(request: PermissionRequest, runId = `run_${request.id}`) {
  const s = session('waiting', {
    activity: { ...waitingOn(request.toolName, 0), since: request.requestedAt },
  });
  return { session: s, prompt: { runId, request } as OpenPrompt };
}

interface Board {
  sessions: SessionSummary[];
  prompts?: Map<string, OpenPrompt>;
  at?: string | null;
}

function renderInbox(board: Board, more: { armMs?: number; locale?: 'en' | 'zh' } = {}) {
  const onOpen = vi.fn();
  const onDecide = vi.fn(async () => {});
  const ui = (b: Board) => (
    <I18nContext.Provider value={makeI18n(more.locale ?? 'en')}>
      <Inbox
        sessions={b.sessions}
        prompts={b.prompts ?? new Map()}
        showProbes={false}
        loaded
        now={NOW}
        at={b.at ?? null}
        armMs={more.armMs ?? 0}
        onOpen={onOpen}
        onDecide={onDecide}
      />
    </I18nContext.Provider>
  );
  const { rerender } = render(ui(board));
  return { onOpen, onDecide, update: (b: Board) => rerender(ui(b)) };
}

const items = () => screen.queryAllByRole('article');
const titles = () => items().map((a) => a.textContent?.match(/Session \d+/)?.[0]);
const region = (name: string) => screen.getByRole('region', { name });

describe('Inbox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    n = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('lists each thing that waits, then each session that looks stuck, saying what each is', () => {
    const permission = held(
      ask('tu_1', 'Bash', 90, { command: 'git push origin main', description: 'Push' }),
    );
    const question = held(ask('tu_2', 'AskUserQuestion', 80));
    const plan = held(ask('tu_3', 'ExitPlanMode', 70, { plan: '## Plan\n\n1. Split the parser' }));
    const terminal = session('waiting', { activity: waitingOn('Bash', 60, 'git push +1') });
    const stuck = session('busy', { trouble: sign('repeat', 300) });
    renderInbox({
      sessions: [stuck, terminal, plan.session, question.session, permission.session],
      prompts: new Map([permission, question, plan].map((h) => [h.session.id, h.prompt])),
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Inbox');
    expect(titles()).toEqual(['Session 1', 'Session 2', 'Session 3', 'Session 4', 'Session 5']);

    const needsYou = region('Needs you');
    expect(within(needsYou).getByText('4')).toHaveClass('figure');
    const [push, beds, parser, term] = within(needsYou).getAllByRole('article') as HTMLElement[];
    // A tool's permission: the command whole, then Deny and Allow.
    expect(push).toHaveAccessibleName('Permission for Bash · Session 1');
    expect(push).toHaveTextContent('Push');
    expect(
      within(push as HTMLElement).getByText('git push origin main', { selector: 'pre' }),
    ).toBeVisible();
    expect(within(push as HTMLElement).getByRole('button', { name: 'Allow' })).toBeEnabled();
    // A question, with the dialog's controls; a plan, read whole.
    expect(within(beds as HTMLElement).getByRole('radio', { name: /North/ })).toBeInTheDocument();
    expect(parser).toHaveTextContent('Plan to approve');
    expect(parser).toHaveTextContent('Split the parser');
    expect(
      within(parser as HTMLElement).getByRole('button', { name: 'Approve' }),
    ).toBeInTheDocument();
    // A terminal's wait says what it is about, where to answer it, and how to get back to it.
    expect(term).toHaveTextContent('Permission · Bash · git push +1');
    expect(term).toHaveTextContent('answer it in the terminal');
    expect(term).toHaveTextContent('cd /w/garden && claude --resume s4');
    expect(
      within(term as HTMLElement).getByRole('button', { name: 'Copy resume command' }),
    ).toHaveAttribute('data-kind', 'primary');

    const looksStuck = region('Looks stuck');
    const [loop] = within(looksStuck).getAllByRole('article') as HTMLElement[];
    expect(loop).toHaveAccessibleName('Looks stuck · Session 5');
    expect(loop).toHaveTextContent('Repeated npm test 4×');
    expect(within(loop as HTMLElement).getByRole('button', { name: 'Open' })).toHaveAttribute(
      'data-kind',
      'primary',
    );
  });

  it('opens a session from its title, and a stuck one from Open', () => {
    const stuck = session('busy', { trouble: sign('failing', 60) });
    const terminal = session('waiting', { activity: waitingOn('Bash', 30) });
    const { onOpen } = renderInbox({ sessions: [stuck, terminal] });
    fireEvent.click(screen.getByRole('link', { name: /Session 2/ }));
    expect(onOpen).toHaveBeenLastCalledWith(terminal.id);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpen).toHaveBeenLastCalledWith(stuck.id);
    // A link still: it opens in a new tab as any.
    expect(screen.getByRole('link', { name: /Session 2/ })).toHaveAttribute(
      'href',
      `#/s/${encodeURIComponent(terminal.id)}`,
    );
  });

  it('copies the resume command, and says so', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    try {
      renderInbox({ sessions: [session('waiting', { activity: waitingOn('Bash', 30) })] });
      fireEvent.click(screen.getByRole('button', { name: 'Copy resume command' }));
      await act(async () => {});
      expect(writeText).toHaveBeenCalledWith('cd /w/garden && claude --resume s1');
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1500));
      expect(screen.getByRole('button', { name: 'Copy resume command' })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers Open, not a command, for a CLI whose command it does not know', () => {
    renderInbox({
      sessions: [session('waiting', { agent: 'oh-my-pi', activity: waitingOn('bash', 30) })],
    });
    expect(screen.queryByRole('button', { name: 'Copy resume command' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('data-kind', 'primary');
  });

  it('says so when nothing waits, and leaves out the stuck section when nothing looks stuck', () => {
    renderInbox({ sessions: [session('idle'), session('busy')] });
    expect(region('Needs you')).toHaveTextContent('Nothing needs you.');
    expect(screen.queryByRole('region', { name: 'Looks stuck' })).toBeNull();
    expect(items()).toEqual([]);
  });

  it('starts on the first item, or on the item of the session it was opened at', () => {
    const a = session('waiting', { activity: waitingOn('Bash', 90) });
    const b = session('waiting', { activity: waitingOn('Edit', 30) });
    const first = renderInbox({ sessions: [a, b] });
    expect(document.activeElement).toBe(items()[0]);
    first.update({ sessions: [a, b], at: b.id });
    expect(document.activeElement).toBe(items()[1]);
  });

  it('acts on the item’s main button with Enter, and comes back to the item with Esc', async () => {
    const permission = held(ask('tu_1', 'Bash', 90, { command: 'npm test' }));
    const { onDecide } = renderInbox({
      sessions: [permission.session],
      prompts: new Map([[permission.session.id, permission.prompt]]),
    });
    const [item] = items() as HTMLElement[];
    const deny = within(item as HTMLElement).getByRole('button', { name: 'Deny' });
    deny.focus();
    fireEvent.keyDown(deny, { key: 'Escape' });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item as HTMLElement, { key: 'Enter' });
    await act(async () => {});
    expect(onDecide).toHaveBeenCalledWith('run_tu_1', 'tu_1', { decision: 'allow' });
  });

  it('is one tab stop: the arrows move between the items, across the sections', () => {
    renderInbox({
      sessions: [
        session('waiting', { activity: waitingOn('Bash', 90) }),
        session('waiting', { activity: waitingOn('Bash', 30) }),
        session('busy', { trouble: sign('errors', 60) }),
      ],
    });
    const all = items() as HTMLElement[];
    expect(all.map((a) => a.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(all[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(all[1]);
    fireEvent.keyDown(all[1] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(all[2]);
    fireEvent.keyDown(all[2] as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(all[0]);
    // Inside an item the arrows are its controls': a question's options move as they do.
    const radio = document.createElement('input');
    radio.type = 'radio';
    all[0]?.append(radio);
    radio.focus();
    fireEvent.keyDown(radio, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(radio);
  });

  it('keeps its order while an item has focus, newcomers last, and sorts again once focus leaves', () => {
    const a = session('waiting', { activity: waitingOn('Bash', 60) });
    const b = session('waiting', { activity: waitingOn('Bash', 30) });
    const { update } = renderInbox({ sessions: [a, b] });
    expect(document.activeElement).toBe(items()[0]);
    // An older wait arrives, and b's turns out older than a's: both would move up.
    const c = session('waiting', { activity: waitingOn('Bash', 600) });
    const older = { ...b, activity: waitingOn('Bash', 120) };
    update({ sessions: [a, older, c] });
    expect(titles()).toEqual(['Session 1', 'Session 2', 'Session 3']);
    expect(document.activeElement).toBe(items()[0]);
    // Focus goes elsewhere: the oldest wait first again.
    const outside = document.createElement('button');
    document.body.append(outside);
    act(() => outside.focus());
    update({ sessions: [a, older, c] });
    expect(titles()).toEqual(['Session 3', 'Session 2', 'Session 1']);
    outside.remove();
  });

  it('moves focus to the next item once the one answered leaves, the last one back, none to the page', () => {
    const a = held(ask('tu_1', 'Bash', 90, { command: 'npm test' }));
    const b = held(ask('tu_2', 'Bash', 60, { command: 'npm run lint' }));
    const c = held(ask('tu_3', 'Bash', 30, { command: 'git push' }));
    const board = (...hs: (typeof a)[]) => ({
      sessions: hs.map((h) => h.session),
      prompts: new Map(hs.map((h) => [h.session.id, h.prompt])),
    });
    const { update } = renderInbox(board(a, b, c));
    expect(document.activeElement).toBe(items()[0]);
    update(board(b, c));
    expect(document.activeElement).toBe(items()[0]);
    expect(items()[0]).toHaveTextContent('npm run lint');
    act(() => (items()[1] as HTMLElement).focus());
    update(board(b));
    expect(document.activeElement).toBe(items()[0]);
    update(board());
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('arms its answers only once the items have stood still', () => {
    const a = held(ask('tu_1', 'Bash', 90, { command: 'npm test' }));
    renderInbox(
      { sessions: [a.session], prompts: new Map([[a.session.id, a.prompt]]) },
      { armMs: PROMPT_ARM_MS },
    );
    const allow = () => screen.getByRole('button', { name: 'Allow' });
    expect(allow()).toBeDisabled();
    act(() => vi.advanceTimersByTime(PROMPT_ARM_MS));
    expect(allow()).toBeEnabled();
  });

  it('speaks Chinese', () => {
    renderInbox(
      {
        sessions: [
          session('waiting', { activity: waitingOn('Bash', 30, 'git push +1') }),
          session('busy', { trouble: sign('repeat', 60) }),
        ],
      },
      { locale: 'zh' },
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('收件箱');
    expect(region('等你处理')).toHaveTextContent('去终端里回答');
    expect(screen.getByRole('button', { name: '复制恢复命令' })).toBeInTheDocument();
    expect(region('看起来卡住了')).toHaveTextContent('重复执行 npm test 4 次');
  });
});
