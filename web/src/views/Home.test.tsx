import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionActivity, SessionSummary } from '../../../src/core/model.js';
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

describe('Home', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    n = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('lists running sessions, then recent ones, each flat and most recently active first', () => {
    const sessions = [
      session('shopfront', 'idle', 120),
      session('glassbox', 'busy', 0, { activity: thinking(72) }),
      session('shopfront', 'waiting', 1),
      session('lantern', 'closed', 18),
      session('glassbox', 'idle', 5),
    ];
    renderHome(sessions);
    const running = screen.getByRole('region', { name: 'Running' });
    expect(running).toHaveTextContent('2 of 5 sessions');
    expect(titles(running)).toEqual(['Session 2', 'Session 3']);
    expect(rows(running).map((r) => r.textContent)).toEqual([
      expect.stringContaining('glassbox /Session 2Thinking · 1:12'),
      expect.stringContaining('shopfront /Session 3Waiting for you'),
    ]);
    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(titles(recent)).toEqual(['Session 5', 'Session 4', 'Session 1']);
    expect(within(recent).getByText('3')).toHaveClass('figure');
    // No project headings: the project leads each row instead.
    expect(screen.queryAllByRole('heading', { level: 3 })).toEqual([]);
  });

  it('says a resting session is idle, and since when, on its second line', () => {
    renderHome([session('a', 'idle', 4)]);
    const meta = screen.getByRole('listitem').querySelector('button')?.lastElementChild;
    expect(meta).toHaveTextContent(/^Idle · 4 ?m(in)?( ago)?$/);
  });

  it('keeps Running when nothing runs, and says so', () => {
    const sessions = [session('a', 'idle', 3), session('b', 'closed', 9)];
    const { onOpen } = renderHome(sessions);
    const running = screen.getByRole('region', { name: 'Running' });
    expect(running).toHaveTextContent('0 of 2 sessions');
    expect(within(running).getByText('Nothing is running.')).toBeInTheDocument();
    expect(within(running).queryByRole('listitem')).toBeNull();
    fireEvent.click(within(running).getByRole('button', { name: /most recently active/ }));
    expect(onOpen).toHaveBeenCalledWith(sessions[0]?.id);
  });

  it('shows the six newest recent sessions, and hides probes unless asked', () => {
    const sessions = Array.from({ length: 9 }, (_, i) => session(`p${i}`, 'closed', i + 1));
    sessions.push(session('probe', 'closed', 0, { tags: ['probe'] }));
    renderHome(sessions);
    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(titles(recent)).toEqual([1, 2, 3, 4, 5, 6].map((i) => `Session ${i}`));
  });

  it('opens the most recently active session of all, running or not', () => {
    // The idle one moved 3 minutes ago, the running one 9 minutes ago.
    const sessions = [session('a', 'idle', 3), session('b', 'busy', 9)];
    const { onOpen } = renderHome(sessions);
    const running = screen.getByRole('region', { name: 'Running' });
    fireEvent.click(within(running).getByRole('button', { name: /most recently active/ }));
    expect(onOpen).toHaveBeenCalledWith(sessions[0]?.id);
  });

  it('is one tab stop: the arrows move between rows, across groups and sections', () => {
    const sessions = [
      session('a', 'busy', 0),
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
        session('a', 'busy', 0, { activity: thinking(10) }),
        session('d', 'busy', 1, { activity: { ...thinking(20), kind: 'writing' } }),
        session('b', 'idle', 5),
        session('c', 'closed', 60),
      ]);
      const before = format.calls;
      expect(vi.getTimerCount()).toBe(1);
      act(() => vi.advanceTimersByTime(3000));
      expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Thinking · 0:13');
      expect(screen.getAllByRole('listitem')[1]).toHaveTextContent('Replying · 0:23');
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
    renderHome([], { loaded: false });
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('Reading local sessions…')).toBeInTheDocument();
  });

  it('words its counts in Chinese, with the figures in the mono face', () => {
    renderHome([session('a', 'busy', 0), session('b', 'idle', 3)], {}, 'zh');
    const running = screen.getByRole('region', { name: '正在运行' });
    expect(running).toHaveTextContent('2 个会话中 1 个');
    expect(
      [...running.querySelectorAll('[class*="count"] .figure')].map((f) => f.textContent),
    ).toEqual(['2', '1']);
  });
});
