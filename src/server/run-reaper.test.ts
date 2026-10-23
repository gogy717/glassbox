import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunState } from '../shared/runs.js';
import { ClientCounter, startRunReaper } from './run-reaper.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-23T02:00:00.000Z');

function run(id: string, status: RunState['status'], updatedAt: number): RunState {
  return {
    id,
    sessionId: null,
    cwd: '/repo',
    mode: 'new',
    status,
    permissionMode: 'default',
    startedAt: new Date(T0 - 60 * MIN).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    pendingPermissions: [],
    partial: null,
    error: null,
    last: null,
  };
}

let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

function setup(runs: RunState[]) {
  const closed: string[] = [];
  const clients = new ClientCounter();
  stop = startRunReaper({
    runs: {
      list: () => runs.filter((r) => !closed.includes(r.id)),
      close: (id) => closed.push(id),
    },
    clients,
  });
  return { closed, clients };
}

describe('ClientCounter', () => {
  it('counts connections and remembers when the last one left', () => {
    const c = new ClientCounter();
    expect(c.count).toBe(0);
    const leave1 = c.join();
    const leave2 = c.join();
    expect(c.count).toBe(2);
    expect(c.unattendedSince()).toBeNull();
    leave1();
    leave1(); // idempotent
    expect(c.count).toBe(1);
    vi.setSystemTime(T0 + 5 * MIN);
    leave2();
    expect(c.unattendedSince()).toBe(T0 + 5 * MIN);
  });
});

describe('startRunReaper', () => {
  it('closes idle runs once nobody has watched them for 30 min', async () => {
    const { closed } = setup([
      run('idle-old', 'idle', T0 - 60 * MIN),
      run('idle-new', 'idle', T0 + 10 * MIN),
      run('running', 'running', T0 - 60 * MIN),
      run('asking', 'waiting-permission', T0 - 60 * MIN),
    ]);
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(closed).toEqual(['idle-old']);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(closed).toEqual(['idle-old', 'idle-new']);
  });

  it('never closes runs while a client is connected', async () => {
    const { closed, clients } = setup([run('idle-old', 'idle', T0 - 60 * MIN)]);
    const leave = clients.join();
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(closed).toEqual([]);

    // The 30 minutes count from when the last client left.
    leave();
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(closed).toEqual(['idle-old']);
  });

  it('stops ticking when stopped', async () => {
    const { closed } = setup([run('idle-old', 'idle', T0 - 60 * MIN)]);
    stop?.();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(closed).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
