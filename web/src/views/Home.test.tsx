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
const labels = (el: HTMLElement) => within(el).getAllByRole('heading', { level: 3 });

describe('Home', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    n = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('lists running sessions, then recent ones, each grouped by project', () => {
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
    expect(labels(running).map((h) => h.textContent)).toEqual(['glassbox', 'shopfront']);
    expect(rows(running).map((r) => r.textContent)).toEqual([
      expect.stringContaining('Thinking · 1:12'),
      expect.stringContaining('Waiting for you'),
    ]);
    const recent = screen.getByRole('region', { name: 'Recent' });
    // Newest first: each project ranked by its newest session.
    expect(labels(recent).map((h) => h.textContent)).toEqual(['glassbox', 'lantern', 'shopfront']);
    expect(within(recent).getByText('3')).toHaveClass('figure');
    for (const h of labels(recent)) expect(h).toHaveClass('section-label');
  });

  it('shows the six newest recent sessions, and hides probes unless asked', () => {
    const sessions = Array.from({ length: 9 }, (_, i) => session(`p${i}`, 'closed', i + 1));
    sessions.push(session('probe', 'closed', 0, { tags: ['probe'] }));
    renderHome(sessions);
    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(labels(recent).map((h) => h.textContent)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    expect(screen.queryByRole('region', { name: 'Running' })).toBeNull();
  });

  it('opens the most recently active session from the first section', () => {
    const sessions = [session('a', 'idle', 3), session('b', 'busy', 9)];
    const { onOpen } = renderHome(sessions);
    const running = screen.getByRole('region', { name: 'Running' });
    fireEvent.click(within(running).getByRole('button', { name: /most recently active/ }));
    expect(onOpen).toHaveBeenCalledWith(sessions[1]?.id);
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

  it('says why a glassbox run failed', () => {
    const failed = session('lantern', 'idle', 18);
    renderHome([failed], { failures: new Map([[failed.id, 'missing file']]) });
    expect(screen.getByRole('listitem')).toHaveTextContent('Failed · missing file');
  });

  it('asks for nothing new, and only the clocks re-render as they tick', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      renderHome([
        session('a', 'busy', 0, { activity: thinking(10) }),
        session('b', 'idle', 5),
        session('c', 'closed', 60),
      ]);
      const before = format.calls;
      act(() => vi.advanceTimersByTime(3000));
      expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Thinking · 0:13');
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
