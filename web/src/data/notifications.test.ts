import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../../../src/core/model.js';
import { makeI18n } from '../i18n';
import { askToNotify, notifyState, useNeedsYouNotifications } from './notifications';

const NOW = Date.parse('2026-10-24T10:00:00.000Z');
/** `s` seconds after the page loaded (negative: before). */
const at = (s: number) => new Date(NOW + s * 1000).toISOString();

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static shown: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  closed = false;
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    FakeNotification.shown.push(this);
  }
  close() {
    this.closed = true;
  }
}

let n = 0;
function waiting(since: string | null, tool: string | null = 'Bash'): SessionSummary {
  n++;
  return {
    id: `claude-code:s${n}`,
    agent: 'claude-code',
    nativeId: `s${n}`,
    title: `Session ${n}`,
    cwd: '/w/shopfront',
    project: 'shopfront',
    startedAt: at(-600),
    updatedAt: since ?? at(-300),
    live: 'waiting',
    version: null,
    model: null,
    usage: null,
    counts: null,
    ...(since ? { activity: { kind: 'waiting', tool, target: null, agentId: 'main', since } } : {}),
  };
}

type Props = { waiting: SessionSummary[]; enabled?: boolean; loaded?: boolean };

function hook(initial: Props) {
  const onOpen = vi.fn();
  const t = makeI18n('en').t;
  const r = renderHook(
    (p: Props) => useNeedsYouNotifications({ enabled: true, loaded: true, t, onOpen, ...p }),
    { initialProps: initial },
  );
  return { ...r, onOpen };
}

describe('useNeedsYouNotifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'granted';
    FakeNotification.shown = [];
    n = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('tells a session that begins to wait once, with what it waits for, and opens it on click', () => {
    const { rerender, onOpen } = hook({ waiting: [] });
    const s = waiting(at(5));
    act(() => vi.setSystemTime(NOW + 5000));
    rerender({ waiting: [s] });
    expect(FakeNotification.shown.map((x) => [x.title, x.options])).toEqual([
      ['shopfront / Session 1', { body: 'Permission · Bash', tag: 'claude-code:s1', silent: true }],
    ]);
    // The same wait again (every list the server sends while it lasts): nothing more.
    rerender({ waiting: [{ ...s }] });
    rerender({ waiting: [{ ...s, updatedAt: at(6) }] });
    expect(FakeNotification.shown).toHaveLength(1);

    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    act(() => FakeNotification.shown[0]?.onclick?.());
    expect(focus).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith('claude-code:s1');
    expect(FakeNotification.shown[0]?.closed).toBe(true);
    focus.mockRestore();
  });

  it('words a question and your turn, and names an untitled session', () => {
    const { rerender } = hook({ waiting: [] });
    act(() => vi.setSystemTime(NOW + 5000));
    rerender({
      waiting: [
        waiting(at(1), 'AskUserQuestion'),
        { ...waiting(null), title: null, updatedAt: at(2) },
      ],
    });
    expect(FakeNotification.shown.map((x) => [x.title, x.options?.body])).toEqual([
      ['shopfront / Session 1', 'Question'],
      ['shopfront / Untitled session', 'Your turn'],
    ]);
  });

  it('tells nothing on page load, nor for a wait that began before the page loaded', () => {
    const already = waiting(at(-20));
    const { rerender } = hook({ waiting: [already], loaded: false });
    // Before the list arrives nothing is known; the list itself is not news.
    rerender({ waiting: [already], loaded: true });
    expect(FakeNotification.shown).toEqual([]);
    // A glassbox run's prompt, replayed after the list: it was asked before the page loaded.
    act(() => vi.setSystemTime(NOW + 2000));
    rerender({ waiting: [already, waiting(at(-5))] });
    expect(FakeNotification.shown).toEqual([]);
    // Since then: news.
    rerender({ waiting: [already, waiting(at(1))] });
    expect(FakeNotification.shown.map((x) => x.title)).toEqual(['shopfront / Session 3']);
  });

  it('stays quiet while the setting is off, and does not catch up once it is on', () => {
    const { rerender } = hook({ waiting: [], enabled: false });
    act(() => vi.setSystemTime(NOW + 5000));
    const first = waiting(at(1));
    rerender({ waiting: [first], enabled: false });
    rerender({ waiting: [first], enabled: true });
    expect(FakeNotification.shown).toEqual([]);
    rerender({ waiting: [first, waiting(at(2))], enabled: true });
    expect(FakeNotification.shown.map((x) => x.title)).toEqual(['shopfront / Session 2']);
  });

  it('closes the notification when the wait ends, and tells a new wait of the same session', () => {
    const { rerender } = hook({ waiting: [] });
    act(() => vi.setSystemTime(NOW + 5000));
    const s = waiting(at(1));
    rerender({ waiting: [s] });
    rerender({ waiting: [] });
    expect(FakeNotification.shown[0]?.closed).toBe(true);
    rerender({
      waiting: [
        { ...s, activity: { ...(s.activity as NonNullable<typeof s.activity>), since: at(3) } },
      ],
    });
    expect(FakeNotification.shown).toHaveLength(2);
  });

  it('shows nothing when the browser refuses the notification', () => {
    vi.stubGlobal(
      'Notification',
      class {
        constructor() {
          throw new TypeError('permission');
        }
      },
    );
    const { rerender } = hook({ waiting: [] });
    act(() => vi.setSystemTime(NOW + 5000));
    expect(() => rerender({ waiting: [waiting(at(1))] })).not.toThrow();
  });
});

describe('notifyState and askToNotify', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the browser once, and reads its answer back after', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission = vi.fn(async () => {
      FakeNotification.permission = 'granted';
      return 'granted' as const;
    });
    expect(notifyState()).toBe('default');
    expect(await askToNotify()).toBe('granted');
    expect(await askToNotify()).toBe('granted');
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    // Refused: the browser remembers, and would ignore another ask.
    FakeNotification.permission = 'denied';
    expect(await askToNotify()).toBe('denied');
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('says so when the browser offers no notifications', async () => {
    vi.stubGlobal('Notification', undefined);
    expect(notifyState()).toBe('unsupported');
    expect(await askToNotify()).toBe('unsupported');
  });
});
