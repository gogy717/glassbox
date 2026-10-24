import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSnapshot } from '../core/invariants.js';
import { DemoStore } from './demo-store.js';
import { WeekService } from './week.js';
import { createDemoWeek } from './week-demo.js';

const NOW = new Date(2026, 9, 24, 20, 41).getTime(); // Sat 24 Oct

describe('the demo week', () => {
  let store: DemoStore;
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    store = new DemoStore();
  });
  afterEach(async () => {
    await store.stop();
    vi.useRealTimers();
  });

  it('is made of well-formed sessions, the same on every run', () => {
    const week = createDemoWeek(NOW);
    for (const s of week) expect(checkSnapshot(s), s.session.id).toEqual([]);
    expect(createDemoWeek(NOW)).toEqual(week);
    expect(week.every((s) => Date.parse(s.session.updatedAt) < NOW)).toBe(true);
  });

  it('gives the weekly receipt a week worth a picture: several CLIs, rhythm, late nights', async () => {
    const r = await new WeekService(store, { now: () => NOW }).compute('7d');
    expect(r.sessions.length).toBeGreaterThan(25);
    expect(new Set(r.sessions.map((s) => s.agent)).size).toBe(5);
    // The demo's own listed sessions are in it too, and its sidebar keeps its three.
    expect(r.sessions.some((s) => s.id.includes('demo-0000'))).toBe(true);
    expect(store.listSessions()).toHaveLength(3);
    const hours = r.window.hourStarts.map((_, i) =>
      r.sessions.reduce((n, s) => n + (s.hours[i] ?? 0), 0),
    );
    const night = r.window.hourStarts.reduce((n, h, i) => {
      const at = new Date(h).getHours();
      return at >= 22 || at < 6 ? n + (hours[i] ?? 0) : n;
    }, 0);
    const all = hours.reduce((a, b) => a + b, 0);
    expect(night / all).toBeGreaterThan(0.08);
    expect(night / all).toBeLessThan(0.5);
    // Quiet hours and busy ones, and sub-agents in parallel past an hour's worth.
    expect(hours.filter((h) => h === 0).length).toBeGreaterThan(60);
    expect(Math.max(...hours)).toBeGreaterThan(60 * 60_000);
    // Grok reports no usage here, so "not reported" has a line to print.
    expect(r.sessions.some((s) => s.agent === 'grok' && !s.inWindow.measured)).toBe(true);
  });
});
