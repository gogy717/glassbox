import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { SessionActivity, SessionSummary } from '../../../src/core/model.js';
import { WAIT_MS } from '../components/Delayed';
import { I18nContext, makeI18n } from '../i18n';
import { Home } from './Home';

// Every row render words its age once: counting the calls counts the rows' renders.
const format = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../lib/format', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/format')>();
  return {
    ...real,
    formatRelative: (...args: Parameters<typeof real.formatRelative>) => {
      format.calls++;
      return real.formatRelative(...args);
    },
  };
});

const NOW = Date.parse('2026-10-24T10:00:00.000Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

let n = 0;
function session(
  project: string,
  live: SessionSummary['live'],
  minutes: number,
  more: Partial<SessionSummary> = {},
): SessionSummary {
  n++;
  return {
    id: `claude-code:s${n}`,
    agent: 'claude-code',
    nativeId: `s${n}`,
    title: `Session ${n}`,
    cwd: `/w/${project}`,
    project,
    startedAt: ago(minutes * 60 + 600),
    updatedAt: ago(minutes * 60),
    live,
    version: null,
    model: null,
    usage: null,
    counts: null,
    ...more,
  };
}
const thinking = (s: number): SessionActivity => ({
  kind: 'thinking',
  tool: null,
  target: null,
  agentId: 'main',
  since: ago(s),
});
const waitingFor = (tool: string | null, s: number): SessionActivity => ({
  kind: 'waiting',
  tool,
  target: null,
  agentId: 'main',
  since: ago(s),
});

function renderHome(
  sessions: SessionSummary[],
  props: Partial<Parameters<typeof Home>[0]> = {},
  locale: 'en' | 'zh' = 'en',
) {
  const onOpen = vi.fn();
  const onNewSession = vi.fn();
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <Home
        sessions={sessions}
        loaded
        now={NOW}
        showProbes={false}
        failures={new Map()}
        onOpen={onOpen}
        onNewSession={onNewSession}
        {...props}
      />
    </I18nContext.Provider>,
  );
  return { onOpen, onNewSession };
}

const rows = (el: HTMLElement) => within(el).getAllByRole('listitem');
const titles = (el: HTMLElement) => rows(el).map((r) => r.textContent?.match(/Session \d+/)?.[0]);
const region = (name: string) => screen.getByRole('region', { name });

describe('Home', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    n = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('lists the sessions that need you, then the working ones, then the recent, each flat', () => {
    const sessions = [
      session('shopfront', 'idle', 120),
      session('glassbox', 'busy', 0, { activity: thinking(72) }),
      session('shopfront', 'waiting', 0, { activity: waitingFor('Bash', 20) }),
      session('lantern', 'closed', 18),
      session('glassbox', 'idle', 5),
      session('lantern', 'waiting', 1, { activity: waitingFor('AskUserQuestion', 62) }),
      // No tool is blocked: the turn finished, since the last write.
      session('mill', 'waiting', 0, { updatedAt: ago(220) }),
    ];
    renderHome(sessions);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Needs you',
      'Working',
      'Recent',
    ]);

    // Each says what it waits for, the longest wait first; the clock replaces the age. A
    // terminal holds these prompts, so they say where to answer them; a turn is not answered.
    const needsYou = region('Needs you');
    expect(titles(needsYou)).toEqual(['Session 7', 'Session 6', 'Session 3']);
    expect(rows(needsYou).map((r) => r.textContent)).toEqual([
      expect.stringMatching(/mill \/Session 7Your turn · 3:40$/),
      expect.stringMatching(/lantern \/Session 6Question · 1:02Answer it in the terminal$/),
      expect.stringMatching(
        /shopfront \/Session 3Permission · Bash · 0:20Answer it in the terminal$/,
      ),
    ]);
    expect(within(needsYou).getByText('3')).toHaveClass('figure');
    expect(within(needsYou).getByText('3')).toHaveAttribute('data-attention');

    const working = region('Working');
    expect(rows(working).map((r) => r.textContent)).toEqual([
      expect.stringContaining('glassbox /Session 2Thinking · 1:12'),
    ]);
    expect(within(working).getByText('1')).not.toHaveAttribute('data-attention');

    const recent = region('Recent');
    expect(titles(recent)).toEqual(['Session 5', 'Session 4', 'Session 1']);
    expect(within(recent).getByText('3')).toHaveClass('figure');
    // No project headings: the project leads each row instead.
    expect(screen.queryAllByRole('heading', { level: 3 })).toEqual([]);
  });

  it('says what a terminal’s prompt is about, and that the terminal is where to answer it', () => {
    const on = (tool: string, target: string, s: number): SessionActivity => ({
      ...waitingFor(tool, s),
      target,
    });
    renderHome([
      session('shopfront', 'waiting', 0, { activity: on('Bash', 'git push +1', 20) }),
      session('lantern', 'waiting', 1, {
        activity: on('AskUserQuestion', 'Which beds first?', 62),
      }),
    ]);
    const [question, push] = rows(region('Needs you'));
    expect(push).toHaveTextContent(
      /shopfront \/Session 1Permission · Bash · git push \+1 · 0:20Answer it in the terminal$/,
    );
    expect(question).toHaveTextContent(
      /lantern \/Session 2Question · Which beds first\? · 1:02Answer it in the terminal$/,
    );
    // The target in the mono face, as a running tool's is.
    expect(within(push as HTMLElement).getByText('git push +1')).toHaveClass(/target/);
  });

  it('leaves the terminal out of a prompt that glassbox holds', () => {
    const held = session('glassbox', 'waiting', 0, { activity: waitingFor('Bash', 20) });
    const request = {
      id: 'tu_1',
      toolName: 'Bash',
      input: { command: 'npm test' },
      questions: null,
      requestedAt: ago(20),
    };
    renderHome([held], { prompts: new Map([[held.id, { runId: 'run_1', request }]]) });
    expect(screen.getByRole('listitem')).not.toHaveTextContent('terminal');
  });

  it('says a resting session is idle, and since when, on its second line', () => {
    renderHome([session('a', 'idle', 4)]);
    const meta = screen.getByRole('listitem').querySelector('button')?.lastElementChild;
    expect(meta).toHaveTextContent(/^Idle · 4 ?m(in)?( ago)?$/);
  });

  it('keeps Needs you and Working when they are empty, and says so', () => {
    renderHome([session('a', 'idle', 3), session('b', 'closed', 9)]);
    const needsYou = region('Needs you');
    expect(within(needsYou).getByText('Nothing needs you.')).toBeInTheDocument();
    expect(within(needsYou).getByText('0')).not.toHaveAttribute('data-attention');
    expect(within(needsYou).queryByRole('listitem')).toBeNull();
    const working = region('Working');
    expect(within(working).getByText('Nothing is working.')).toBeInTheDocument();
    expect(within(working).queryByRole('listitem')).toBeNull();
    expect(titles(region('Recent'))).toEqual(['Session 1', 'Session 2']);
  });

  // The Session page opens the most recently active session: the header keeps one action.
  it('offers a new session from the header, and no link to the latest session', () => {
    const { onNewSession } = renderHome([session('a', 'idle', 3)]);
    const needsYou = region('Needs you');
    expect(
      within(needsYou)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['New session']);
    fireEvent.click(within(needsYou).getByRole('button', { name: 'New session' }));
    expect(onNewSession).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /most recently active/ })).toBeNull();
  });

  it('shows the six newest recent sessions, and hides probes unless asked', () => {
    const sessions = Array.from({ length: 9 }, (_, i) => session(`p${i}`, 'closed', i + 1));
    sessions.push(session('probe', 'closed', 0, { tags: ['probe'] }));
    sessions.push(session('probe', 'waiting', 0, { tags: ['probe'] }));
    renderHome(sessions);
    expect(titles(region('Recent'))).toEqual([1, 2, 3, 4, 5, 6].map((i) => `Session ${i}`));
    expect(within(region('Needs you')).queryByRole('listitem')).toBeNull();
  });

  it('is one tab stop: the arrows move between rows, across sections', () => {
    const sessions = [
      session('a', 'waiting', 0),
      session('b', 'busy', 1),
      session('a', 'idle', 2),
      session('c', 'closed', 3),
    ];
    const { onOpen } = renderHome(sessions);
    const buttons = screen.getAllByRole('listitem').map((li) => within(li).getByRole('button'));
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1]);
    buttons[0]?.focus();
    fireEvent.keyDown(buttons[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1] as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[2]);
    fireEvent.keyDown(buttons[2] as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(buttons[3]);
    expect(buttons.map((b) => b.tabIndex)).toEqual([-1, -1, -1, 0]);
    fireEvent.keyDown(buttons[3] as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(buttons[0]);
    // A row is a button: Enter and Space open it as a click does.
    expect(buttons[0]?.tagName).toBe('BUTTON');
    fireEvent.click(buttons[0] as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith(sessions[0]?.id);
  });

  it('keeps the tab stop on the row of the session open last', () => {
    const sessions = [session('a', 'busy', 0), session('b', 'idle', 1), session('c', 'closed', 2)];
    renderHome(sessions, { lastOpened: sessions[2]?.id });
    const buttons = screen.getAllByRole('listitem').map((li) => within(li).getByRole('button'));
    expect(buttons.map((b) => b.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('says why a glassbox run failed', () => {
    const failed = session('lantern', 'idle', 18);
    renderHome([failed], { failures: new Map([[failed.id, 'missing file']]) });
    expect(screen.getByRole('listitem')).toHaveTextContent('Failed · missing file');
  });

  it('asks for nothing new, and only the clocks re-render as they tick, on one interval', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      renderHome([
        session('w', 'waiting', 0, { activity: waitingFor('Bash', 30) }),
        session('a', 'busy', 0, { activity: thinking(10) }),
        session('d', 'busy', 1, { activity: { ...thinking(20), kind: 'writing' } }),
        session('b', 'idle', 5),
        session('c', 'closed', 60),
      ]);
      const before = format.calls;
      expect(vi.getTimerCount()).toBe(1);
      act(() => vi.advanceTimersByTime(3000));
      const items = screen.getAllByRole('listitem');
      expect(items[0]).toHaveTextContent('Permission · Bash · 0:33');
      expect(items[1]).toHaveTextContent('Thinking · 0:13');
      expect(items[2]).toHaveTextContent('Replying · 0:23');
      expect(format.calls).toBe(before);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says where it looks when there are no sessions, and offers a new one', () => {
    const { onNewSession } = renderHome([]);
    expect(screen.getByRole('heading', { name: 'No sessions on this machine' })).toBeVisible();
    const list = screen.getByRole('list');
    for (const name of ['Claude Code', 'Codex', 'Grok', 'oh-my-pi', 'OpenCode'])
      expect(list).toHaveTextContent(name);
    for (const dir of ['~/.claude/projects', '~/.codex', '~/.grok', '~/.omp/agent/sessions'])
      expect(list).toHaveTextContent(dir);
    expect(list).toHaveTextContent('~/.local/share/opencode');
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(onNewSession).toHaveBeenCalled();
  });

  it('says nothing about sessions before the list arrives', () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    renderHome([], { loaded: false });
    expect(screen.queryByRole('heading')).toBeNull();
    // F-web W8: only once the wait has lasted 200 ms.
    expect(screen.queryByText('Reading local sessions…')).toBeNull();
    act(() => vi.advanceTimersByTime(WAIT_MS));
    expect(screen.getByText('Reading local sessions…')).toBeInTheDocument();
  });

  it('words its sections in Chinese, with the counts in the mono face', () => {
    renderHome(
      [
        session('a', 'waiting', 0, { activity: waitingFor('Bash', 20) }),
        session('b', 'busy', 0),
        session('c', 'idle', 3),
      ],
      {},
      'zh',
    );
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      '等你处理',
      '工作中',
      '最近的会话',
    ]);
    expect(region('等你处理')).toHaveTextContent('权限 · Bash · 已 0:20');
    expect(within(region('等你处理')).getByRole('button', { name: '新会话' })).toBeInTheDocument();
    expect(
      [...document.querySelectorAll('[class*="count"]')].map((f) => [
        f.textContent,
        f.classList.contains('figure'),
      ]),
    ).toEqual([
      ['1', true],
      ['1', true],
      ['1', true],
    ]);
  });
});
