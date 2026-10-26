import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionActivity, SessionSummary, TroubleSignal } from '../../../../src/core/model.js';
import type { PermissionRequest } from '../../../../src/shared/runs.js';
import type { OpenPrompt } from '../../data/runs';
import { useShortcuts } from '../../data/shortcuts';
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
  call?: number;
}

/** The page's key map, as App listens for it. */
function Keys() {
  useShortcuts();
  return null;
}

function renderInbox(board: Board, more: { armMs?: number; locale?: 'en' | 'zh' } = {}) {
  const onOpen = vi.fn();
  const onDecide = vi.fn(async () => {});
  const ui = (b: Board) => (
    <I18nContext.Provider value={makeI18n(more.locale ?? 'en')}>
      <Keys />
      <Inbox
        sessions={b.sessions}
        prompts={b.prompts ?? new Map()}
        showProbes={false}
        loaded
        now={NOW}
        at={b.at ?? null}
        call={b.call ?? 0}
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

  it('waits for the item asked for when it comes after the others, and takes no other meanwhile', () => {
    const a = session('waiting', { activity: waitingOn('Bash', 90) });
    const b = session('waiting', { activity: waitingOn('Edit', 30) });
    const { update } = renderInbox({ sessions: [a], at: b.id });
    // Not there yet: no item has focus, so no key answers another session's.
    expect(document.activeElement).toBe(document.body);
    update({ sessions: [a, b], at: b.id });
    expect(document.activeElement).toBe(items()[1]);
  });

  it('stays on the item the person moved to when the one asked for comes late', () => {
    const a = session('waiting', { activity: waitingOn('Bash', 90) });
    const b = session('waiting', { activity: waitingOn('Edit', 30) });
    const { update } = renderInbox({ sessions: [a], at: b.id });
    act(() => (items()[0] as HTMLElement).focus());
    update({ sessions: [a, b], at: b.id });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('goes back to the item asked for each time it is asked, the one named already included', () => {
    const a = session('waiting', { activity: waitingOn('Bash', 90) });
    const b = session('waiting', { activity: waitingOn('Edit', 30) });
    const { update } = renderInbox({ sessions: [a, b], at: a.id, call: 1 });
    expect(document.activeElement).toBe(items()[0]);
    act(() => (items()[1] as HTMLElement).focus());
    // Its notification again: the same link, asked for once more.
    update({ sessions: [a, b], at: a.id, call: 2 });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('starts on the first item to arrive when the page opened on none, unless focus is elsewhere', () => {
    // The list arrives before the runs' prompts: at first, nothing waits.
    const a = held(ask('tu_1', 'Bash', 30, { command: 'npm test' }));
    const { update } = renderInbox({
      sessions: [{ ...a.session, live: 'busy', activity: undefined }],
    });
    expect(items()).toEqual([]);
    update({ sessions: [a.session], prompts: new Map([[a.session.id, a.prompt]]) });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('starts on the first item even from the link that opened it, outside the page', () => {
    const link = document.createElement('a');
    link.href = '#/inbox';
    document.body.append(link);
    act(() => link.focus());
    renderInbox({ sessions: [session('waiting', { activity: waitingOn('Bash', 30) })] });
    expect(document.activeElement).toBe(items()[0]);
    link.remove();
  });

  it('leaves focus where it is when the first item arrives while it is elsewhere', () => {
    const a = session('waiting', { activity: waitingOn('Bash', 30) });
    const { update } = renderInbox({ sessions: [] });
    const outside = document.createElement('button');
    document.body.append(outside);
    act(() => outside.focus());
    update({ sessions: [a] });
    expect(document.activeElement).toBe(outside);
    outside.remove();
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

  it('leaves a key with a modifier held to the browser: Alt+← goes Back, ⌘Enter allows nothing', async () => {
    const a = held(ask('tu_1', 'Bash', 90, { command: 'npm test' }));
    const { onDecide } = renderInbox({
      sessions: [a.session, session('waiting', { activity: waitingOn('Bash', 30) })],
      prompts: new Map([[a.session.id, a.prompt]]),
    });
    const first = items()[0] as HTMLElement;
    // fireEvent says false when the page took the key (its default prevented).
    expect(fireEvent.keyDown(first, { key: 'ArrowLeft', altKey: true })).toBe(true);
    expect(fireEvent.keyDown(first, { key: 'ArrowDown', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(first, { key: 'End', ctrlKey: true })).toBe(true);
    expect(document.activeElement).toBe(first);
    for (const held of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }])
      expect(fireEvent.keyDown(first, { key: 'Enter', ...held })).toBe(true);
    await act(async () => {});
    expect(onDecide).not.toHaveBeenCalled();
    // Held down, Enter presses once: the repeats do not answer each next item as it arms.
    fireEvent.keyDown(first, { key: 'Enter', repeat: true });
    await act(async () => {});
    expect(onDecide).not.toHaveBeenCalled();
    // Alone, the keys are the list's.
    expect(fireEvent.keyDown(first, { key: 'ArrowDown' })).toBe(false);
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

  it('comes back to the list from the heading when something waits again, the last one gone', () => {
    const a = held(ask('tu_1', 'Bash', 90, { command: 'npm test' }));
    const board = (...hs: (typeof a)[]) => ({
      sessions: hs.map((h) => h.session),
      prompts: new Map(hs.map((h) => [h.session.id, h.prompt])),
    });
    const { update } = renderInbox(board(a));
    expect(document.activeElement).toBe(items()[0]);
    // Answered: the run asks nothing for a moment, then asks again.
    update(board());
    const heading = screen.getByRole('heading', { level: 1 });
    expect(document.activeElement).toBe(heading);
    const next = { ...a, prompt: { ...a.prompt, request: ask('tu_2', 'AskUserQuestion', 1) } };
    update(board(next));
    expect(document.activeElement).toBe(items()[0]);
    // Not when focus went elsewhere meanwhile.
    update(board());
    const outside = document.createElement('button');
    document.body.append(outside);
    act(() => outside.focus());
    update(board(a));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('keeps focus on an item whose session asks again while one of its buttons had focus', () => {
    const a = held(ask('tu_1', 'Bash', 90, { command: 'npm test' }));
    const b = held(ask('tu_5', 'Bash', 60, { command: 'npm run lint' }));
    const board = (...hs: (typeof a)[]) => ({
      sessions: hs.map((h) => h.session),
      prompts: new Map(hs.map((h) => [h.session.id, h.prompt])),
    });
    const { update } = renderInbox(board(a, b));
    act(() =>
      within(items()[0] as HTMLElement)
        .getByRole('button', { name: 'Deny' })
        .focus(),
    );
    // The same run asks again at once: the same item, another prompt, fresh buttons.
    const again = {
      ...a,
      prompt: { ...a.prompt, request: ask('tu_2', 'Bash', 1, { command: 'git push' }) },
    };
    update(board(again, b));
    expect(items()[0]).toHaveTextContent('git push');
    expect(document.activeElement).toBe(items()[0]);
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

  describe('keys', () => {
    /** A key pressed where focus is, as the page's listener hears it. */
    const press = (key: string) =>
      fireEvent.keyDown(document.activeElement ?? document.body, { key });

    function three() {
      const a = held(ask('tu_1', 'Bash', 90, { command: 'npm test' }));
      const b = held(ask('tu_2', 'ExitPlanMode', 60, { plan: '1. Split the parser' }));
      const c = session('busy', { trouble: sign('repeat', 30) });
      const r = renderInbox({
        sessions: [a.session, b.session, c],
        prompts: new Map([a, b].map((h) => [h.session.id, h.prompt])),
      });
      return { ...r, a, b, c };
    }

    it('moves down and up the items with j and k, from wherever focus is', () => {
      three();
      const all = items();
      expect(document.activeElement).toBe(all[0]);
      press('j');
      expect(document.activeElement).toBe(all[1]);
      press('j');
      press('j');
      expect(document.activeElement).toBe(all[2]);
      press('k');
      expect(document.activeElement).toBe(all[1]);
      // From one of an item's buttons, the next item.
      act(() =>
        within(all[1] as HTMLElement)
          .getByRole('button', { name: 'Reject' })
          .focus(),
      );
      press('j');
      expect(document.activeElement).toBe(all[2]);
      // From outside the list, back onto it.
      act(() => (document.activeElement as HTMLElement).blur());
      press('j');
      expect(document.activeElement).toBe(all[2]);
    });

    it('allows with y and denies with n, the item focus is on', async () => {
      const { onDecide } = three();
      press('y');
      await act(async () => {});
      expect(onDecide).toHaveBeenLastCalledWith('run_tu_1', 'tu_1', { decision: 'allow' });
      press('j');
      press('n');
      await act(async () => {});
      expect(onDecide).toHaveBeenLastCalledWith('run_tu_2', 'tu_2', { decision: 'deny' });
      // A stuck session has nothing to allow.
      press('j');
      press('y');
      await act(async () => {});
      expect(onDecide).toHaveBeenCalledTimes(2);
    });

    it('opens the session of the item focus is on with o', () => {
      const { onOpen, c } = three();
      press('j');
      press('j');
      press('o');
      expect(onOpen).toHaveBeenCalledWith(c.id);
    });

    it('answers nothing while focus is off the items, or before the answers are armed', async () => {
      const a = held(ask('tu_1', 'Bash', 90, { command: 'npm test' }));
      const { onDecide, onOpen } = renderInbox(
        { sessions: [a.session], prompts: new Map([[a.session.id, a.prompt]]) },
        { armMs: PROMPT_ARM_MS },
      );
      press('y');
      await act(async () => {});
      expect(onDecide).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(PROMPT_ARM_MS));
      act(() => (document.activeElement as HTMLElement).blur());
      press('y');
      press('n');
      press('o');
      await act(async () => {});
      expect(onDecide).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('takes no keys while an option of a question has focus, and Esc comes back to the item', async () => {
      const q = held(ask('tu_5', 'AskUserQuestion', 30));
      const { onDecide, onOpen } = renderInbox({
        sessions: [q.session],
        prompts: new Map([[q.session.id, q.prompt]]),
      });
      const [item] = items() as HTMLElement[];
      const north = within(item as HTMLElement).getByRole('radio', { name: /North/ });
      act(() => north.focus());
      for (const key of ['y', 'n', 'o', 'j', 'k']) press(key);
      await act(async () => {});
      expect(document.activeElement).toBe(north);
      expect(onDecide).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
      press('Escape');
      expect(document.activeElement).toBe(item);
      // Picked, the answer goes with y from the item.
      fireEvent.click(north);
      act(() => (item as HTMLElement).focus());
      press('y');
      await act(async () => {});
      expect(onDecide).toHaveBeenCalledWith('run_tu_5', 'tu_5', {
        decision: 'allow',
        answers: { 'Which beds first?': 'North' },
      });
    });
  });
});
