import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSnapshot } from '../core/invariants.js';
import { crossings } from '../shared/crossing.js';
import { DemoStore } from './demo-store.js';
import { WeekService } from './week.js';
import { createDemoWeek, demoRepo } from './week-demo.js';

const NOW = new Date(2026, 10, 21, 20, 41).getTime(); // Sat 21 Nov

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
    // The demo's own listed sessions are in it too, and its sidebar keeps its four.
    expect(r.sessions.some((s) => s.id.includes('demo-0000'))).toBe(true);
    expect(store.listSessions()).toHaveLength(4);
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
    expect(r.sessions.some((s) => s.agent === 'grok' && !s.reportsUsage)).toBe(true);
  });

  it('shows the time the agents waited on the person: questions, plans, permission prompts and gaps between prompts', async () => {
    const r = await store.week.compute('7d');
    const waited = r.sessions.flatMap((s) => (s.inWindow.waiting ? [s.inWindow.waiting] : []));
    expect(waited.length).toBeGreaterThan(5);
    expect(new Set(waited.flatMap((w) => Object.keys(w.byKind)))).toEqual(
      new Set(['permission', 'question', 'plan', 'turn']),
    );
    const longest = Math.max(...waited.map((w) => w.longestMs));
    expect(longest).toBeGreaterThan(60_000);
    // Each session's waits add up to its share of the week's, and its longest is one of them.
    for (const w of waited) {
      expect(Object.values(w.byKind).reduce((a, b) => a + (b ?? 0), 0)).toBe(w.ms);
      expect(w.longestMs).toBeLessThanOrEqual(w.ms);
    }
  });

  it('works on glassbox in a second worktree too, whose changes cross the main tree’s', async () => {
    const r = await new WeekService(store, { now: () => NOW, repoOf: demoRepo }).compute('7d');
    const repos = crossings(
      r.sessions.map((s) => ({ id: s.id, repo: s.repo, files: s.inWindow.files })),
    );
    expect(repos.map((c) => c.name)).toEqual(['glassbox']);
    expect(repos[0]?.trees.map((t) => [t.name, t.main])).toEqual([
      ['glassbox', true],
      ['glassbox-sidebar', false],
    ]);
    const overlap = new Map(repos[0]?.paths.map((p) => [p.path, p.overlap]));
    // The open session's fix and the worktree's change meet on one line; elsewhere they part.
    expect(overlap.get('src/server/store.ts')).toBe(true);
    expect(overlap.get('src/server/sessions.ts')).toBe(false);
    expect(overlap.get('src/app.ts')).toBe(null);
  });

  it('calls a few MCP servers, in both name shapes, one call failed, and counts them', async () => {
    const week = createDemoWeek(NOW);
    const names = week.flatMap((s) => s.toolCalls.map((t) => t.name));
    expect(names.some((n) => n.startsWith('mcp__tracker__'))).toBe(true);
    expect(names.some((n) => n.startsWith('mcp__docs__'))).toBe(true);
    expect(names.some((n) => n.startsWith('tracker__'))).toBe(true);
    const r = await new WeekService(store, { now: () => NOW }).compute('7d');
    const servers = new Map<string, { calls: number; failures: number }>();
    for (const s of r.sessions)
      for (const [name, m] of Object.entries(s.inWindow.mcp ?? {})) {
        const was = servers.get(name) ?? { calls: 0, failures: 0 };
        servers.set(name, { calls: was.calls + m.calls, failures: was.failures + m.failures });
      }
    expect([...servers.keys()].sort()).toEqual(['docs', 'tracker']);
    const calls = [...servers.values()].reduce((n, m) => n + m.calls, 0);
    expect(calls).toBeGreaterThan(5);
    expect(calls).toBeLessThan(80);
    expect([...servers.values()].some((m) => m.failures > 0)).toBe(true);
  });

  it('reads a worktree of a demo repository as that repository’s, and opens the week’s sessions', async () => {
    expect(demoRepo('/Users/demo/Dev/worktrees/glassbox-sidebar')).toEqual({
      root: '/Users/demo/Dev/glassbox',
      dir: '/Users/demo/Dev/worktrees/glassbox-sidebar',
      name: 'glassbox',
    });
    expect(demoRepo('/Users/demo/Dev/blog')).toEqual({
      root: '/Users/demo/Dev/blog',
      dir: '/Users/demo/Dev/blog',
      name: 'blog',
    });
    // Never listed, but open: the Crossing panel shows their edits.
    const id = store.weekSessions().find((s) => s.cwd?.includes('/worktrees/'))?.id ?? '';
    expect(store.listSessions().some((s) => s.id === id)).toBe(false);
    expect((await store.getSnapshot(id))?.session.id).toBe(id);
  });
});
