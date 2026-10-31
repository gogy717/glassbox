import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_SESSION_ID } from '../core/fixtures/demo.js';
import { burnSince, topBurn } from '../shared/quota-burn.js';
import { CONTEXT_DEMO_ID, DemoStore } from './demo-store.js';
import { createDemoBurn } from './quota-burn-demo.js';

// Monday 7:00, before the demo week's morning block: the week places its sessions by the time of
// day, so the list would read differently at another hour. Only the date is faked: the reading
// yields with setImmediate.
const MONDAY_7 = new Date(2026, 10, 2, 7, 0);

const stores: DemoStore[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MONDAY_7);
});
afterEach(async () => {
  for (const s of stores.splice(0)) await s.stop();
  vi.useRealTimers();
});

const demo = () => {
  const store = new DemoStore();
  stores.push(store);
  return store;
};

describe("the demo's Who used it", () => {
  it('lists Claude’s five-hour window, led by the two running demo sessions, with more than five sessions', async () => {
    const store = demo();
    const now = Date.now();
    const quota = store.listQuotas().find((q) => q.provider === 'anthropic');
    const burn = await store.burn.compute('anthropic', burnSince(quota, now));
    expect(burn.counted).toBe('tokens');
    // The session near its context window read the most (its 22 calls each carry the context);
    // the open demo session comes second. Neither holds over half, so "mostly" stays off.
    expect(burn.sessions.slice(0, 2).map((s) => s.id)).toEqual([CONTEXT_DEMO_ID, DEMO_SESSION_ID]);
    expect(burn.sessions[0]?.share).toBeGreaterThan(0.4);
    expect(burn.sessions[1]?.share).toBeGreaterThan(0.2);
    const { top, more } = topBurn(burn.sessions, 5);
    expect(top).toHaveLength(5);
    expect(more.count).toBeGreaterThan(0);
    // OpenCode's request to a Claude model counts; Codex's sessions do not.
    expect(burn.sessions.some((s) => s.agent === 'opencode')).toBe(true);
    expect(burn.sessions.some((s) => s.agent === 'codex')).toBe(false);
  });

  it('lists Codex’s window between its two sessions', async () => {
    const store = demo();
    const now = Date.now();
    const quota = store.listQuotas().find((q) => q.provider === 'openai');
    const burn = await store.burn.compute('openai', burnSince(quota, now));
    expect(burn.sessions.map((s) => s.agent)).toEqual(['codex', 'codex']);
  });

  it('is synthetic: made-up projects under the demo’s home, and not listed as sessions', () => {
    const store = demo();
    const listed = new Set(store.listSessions().map((s) => s.id));
    for (const s of createDemoBurn(Date.now())) {
      expect(s.session.cwd?.startsWith('/Users/demo/')).toBe(true);
      expect(listed.has(s.session.id)).toBe(false);
    }
  });
});
