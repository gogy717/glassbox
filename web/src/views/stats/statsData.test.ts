import { describe, expect, it } from 'vitest';
import type { WeekSession } from '../../../../src/shared/week.js';
import { listedOnly, weekReceipt } from '../../components/receipt/week';
import { demoWeek, WEEK_NOW } from '../../test/week';
import {
  busiestCell,
  cellLabels,
  hourOfCell,
  hourSpan,
  indexHours,
  isolated,
  longestSessions,
  sameIsolate,
  statsWeek,
  timeText,
  topProjects,
} from './statsData';

const r = demoWeek('week');
const w = statsWeek(r, false);
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

describe('the Stats page projects', () => {
  it('counts a repository’s worktrees as one project, named like the session list names it', () => {
    const base = demoWeek();
    const [a, b, c] = base.sessions as [WeekSession, WeekSession, WeekSession];
    const repo = { root: '/home/dev/src/glassbox', name: 'glassbox' };
    const sessions: WeekSession[] = [
      {
        ...a,
        cwd: '/home/dev/src/glassbox',
        project: 'glassbox',
        repo: { ...repo, dir: '/home/dev/src/glassbox' },
      },
      {
        ...b,
        cwd: '/home/dev/work/whitefish',
        project: 'whitefish',
        repo: { ...repo, dir: '/home/dev/work/whitefish' },
      },
      { ...c, cwd: '/home/dev/notes', project: 'notes', repo: null },
    ];
    const w = statsWeek({ ...base, sessions }, false);
    const top = topProjects(w);
    expect(top.map((p) => [p.name, p.sessions])).toEqual([
      ['glassbox', 2],
      ['notes', 1],
    ]);
    expect(top[0]?.ms).toBe(a.inWindow.agentMs + b.inWindow.agentMs);
    expect(isolated(w, { project: 'glassbox' }).result.sessions.map((s) => s.id)).toEqual([
      a.id,
      b.id,
    ]);
    expect(w.receipt.projects).toBe(2);
  });
});

describe('the Stats page figures', () => {
  it('are the weekly receipt’s own, from the same listed sessions (N6)', () => {
    expect(w.receipt).toEqual(weekReceipt(listedOnly(r, false)));
    const probed = {
      ...r,
      sessions: r.sessions.map((s, i) => (i ? s : { ...s, tags: ['probe'] })),
    };
    expect(statsWeek(probed, false).result.sessions).toHaveLength(r.sessions.length - 1);
    expect(statsWeek(probed, true).result.sessions).toHaveLength(r.sessions.length);
  });

  it('rank the projects by agent time, each with its sessions, as many as the week counts', () => {
    const all = topProjects(w, 99);
    expect(all).toHaveLength(w.receipt.projects);
    expect(all.map((p) => p.ms)).toEqual([...all.map((p) => p.ms)].sort((a, b) => b - a));
    expect(sum(all.map((p) => p.sessions))).toBeLessThanOrEqual(w.result.sessions.length);
    const first = all[0];
    if (!first) throw new Error('fixture');
    const mine = w.result.sessions.filter((s) => (s.cwd ?? '').endsWith(`/${first.name}`));
    expect(first.ms).toBe(sum(mine.map((s) => s.inWindow.agentMs)));
    expect(first.sessions).toBe(mine.length);
    expect(topProjects(w)).toHaveLength(Math.min(5, all.length));
  });

  it('rank the longest sessions by their own clock, five at most', () => {
    const rows = longestSessions(w);
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(rows.map((x) => x.ms)).toEqual(
      w.result.sessions
        .map((s) => s.inWindow.activeMs)
        .filter((ms) => ms > 0)
        .sort((a, b) => b - a)
        .slice(0, 5),
    );
    expect(rows[0]?.ms).toBe(w.receipt.longest?.ms);
  });

  it('select the busiest hour first, its cell holding the busiest minutes', () => {
    const at = busiestCell(w);
    if (!at) throw new Error('fixture');
    const cell = w.receipt.grid[at.row]?.[at.col];
    expect(cell?.ms).toBe(w.receipt.busiest?.ms);
    expect(w.result.window.hourStarts[cell?.hours[0] ?? -1]).toBe(w.receipt.busiest?.at);
  });

  it('list an hour’s sessions most minutes first, adding up to its cell, with its top CLI', () => {
    const at = busiestCell(w);
    const cell = at && w.receipt.grid[at.row]?.[at.col];
    if (!cell) throw new Error('fixture');
    const hour = hourOfCell(w, cell);
    expect(hour.start).toBe(w.receipt.busiest?.at);
    expect(hour.ms).toBe(cell.ms);
    expect(sum(hour.sessions.map((s) => s.ms))).toBe(cell.ms);
    expect(hour.sessions.map((s) => s.ms)).toEqual(
      [...hour.sessions.map((s) => s.ms)].sort((a, b) => b - a),
    );
    const byCli = new Map<string, number>();
    for (const s of hour.sessions) byCli.set(s.agent, (byCli.get(s.agent) ?? 0) + s.ms);
    expect(hour.topCli?.ms).toBe(Math.max(...byCli.values()));
  });

  it('redraw the grid with one CLI’s minutes, or one project’s', () => {
    for (const cli of w.receipt.byCli) {
      const g = isolated(w, { cli: cli.agent });
      expect(g.receipt.agentMs).toBe(cli.ms);
      expect(sum(g.receipt.grid.flat().map((c) => c.ms))).toBe(cli.ms);
      expect(g.result.sessions.every((s) => s.agent === cli.agent)).toBe(true);
    }
    const [project] = topProjects(w);
    if (!project) throw new Error('fixture');
    expect(isolated(w, { project: project.name }).receipt.agentMs).toBe(project.ms);
  });

  it('tell a CLI from a project of the same name: pins go by what they are (M6)', () => {
    expect(sameIsolate({ cli: 'codex' }, { cli: 'codex' })).toBe(true);
    expect(sameIsolate({ project: 'Codex' }, { project: 'Codex' })).toBe(true);
    expect(sameIsolate({ cli: 'codex' }, { project: 'Codex' })).toBe(false);
    expect(sameIsolate({ project: 'codex' }, { cli: 'codex' })).toBe(false);
    expect(sameIsolate(null, { cli: 'codex' })).toBe(false);
  });

  it('label every cell once, from the hours’ index, as its hour reads (I1)', () => {
    const labels = cellLabels(w, 'week', 'en');
    expect(labels.flat()).toHaveLength(168);
    const at = busiestCell(w);
    const cell = at && w.receipt.grid[at.row]?.[at.col];
    if (!at || !cell) throw new Error('fixture');
    const hour = hourOfCell(w, cell, indexHours(w));
    expect(hour).toEqual(hourOfCell(w, cell));
    expect(labels[at.row]?.[at.col]).toEqual({
      title: hourSpan(hour.start ?? 0, 'week', 'en'),
      line: expect.stringMatching(
        new RegExp(`^${timeText(hour.ms, 'en')} · ${hour.sessions.length} sessions? · `),
      ),
    });
  });

  it('have no busiest hour, and no rows, in a week with no sessions', () => {
    const empty = statsWeek({ ...r, sessions: [] }, false);
    expect(busiestCell(empty)).toBeNull();
    expect(topProjects(empty)).toEqual([]);
    expect(longestSessions(empty)).toEqual([]);
    expect(empty.receipt.now).toBe(WEEK_NOW);
  });
});
