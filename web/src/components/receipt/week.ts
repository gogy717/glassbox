/**
 * What the weekly receipt says, from `/api/week`'s result: the server cut every session to the
 * window; here they are only added up, ranked and laid out. Each figure keeps the session
 * receipt's meaning, so a week of one session prints that session's numbers.
 */
import type { AgentKind } from '../../../../src/core/model.js';
import { addUsage, contextSize, emptyUsage, totalTokens } from '../../../../src/core/usage.js';
import type { ToolCategory } from '../../../../src/shared/tool-category.js';
import type { WeekResult, WeekWindowKind } from '../../../../src/shared/week.js';
import { printedProject, printedTitle } from './printed';
import { shares } from './rows';
import type { TokenFigures } from './slip';

const HOUR = 3_600_000;

export interface GridCell {
  /** Agent time in the hour (ms). */
  ms: number;
  /** 'future': after now, outlined; 'out': not in the window, not drawn. */
  state: 'past' | 'future' | 'out';
}

export interface WeekReceipt {
  kind: WeekWindowKind;
  /** First hour of the window, and when it ends (the time printed). */
  start: number;
  now: number;
  sessions: number;
  projects: number;
  /** CLIs with activity, the busiest first. */
  clis: AgentKind[];
  /** The hero: every session's active time in the window, added up. */
  agentMs: number;
  /** 7 rows of 24 hours; `rows[i]` is a time on that row's day (for its weekday). */
  grid: GridCell[][];
  rows: number[];
  /** The now cursor: after `col` on `row` (R20). */
  cursor: { row: number; col: number };
  busiest: { at: number; ms: number } | null;
  /** Share of agent time between 22:00 and 06:00, 0..1. */
  afterHours: number | null;
  work: {
    requests: number;
    toolCalls: number;
    categories: { category: ToolCategory; count: number }[];
    subAgents: number;
    failures: number;
  };
  /** Agent time by CLI, the shares adding up to 100. */
  byCli: { agent: AgentKind; ms: number; share: number }[];
  longest: { agent: AgentKind; project: string | null; title: string | null; ms: number } | null;
  tokens: TokenFigures;
  /** Sessions that reported no usage, by CLI: the TOKENS note. */
  unreported: { agent: AgentKind; n: number }[];
}

/** Days from `a`'s local date to `b`'s. */
const daysBetween = (a: number, b: number) => {
  const d0 = new Date(a);
  const d1 = new Date(b);
  return Math.round(
    (Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate()) -
      Date.UTC(d0.getFullYear(), d0.getMonth(), d0.getDate())) /
      86_400_000,
  );
};

/**
 * The 7 × 24 grid. This week: Monday to Sunday, hours after now outlined. The last 7 days: the
 * seven days in order, today last; today's row holds both ends of the window, its hours up to now
 * from today and the rest from the same weekday a week ago (R20). The cursor stands after the
 * current hour on today's row in both.
 */
function layGrid(r: WeekResult, totals: number[]) {
  const { hourStarts, now } = r.window;
  const grid: GridCell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, (): GridCell => ({ ms: 0, state: 'out' })),
  );
  const start = hourStarts[0] ?? now;
  const week = r.window.kind === 'week';
  const today = week ? daysBetween(start, now) : 6;
  hourStarts.forEach((h, i) => {
    const days = daysBetween(start, h);
    // A week back is today's weekday again: the right end of today's row.
    const back = daysBetween(h, now);
    const row = week ? days : back >= 7 ? 6 : 6 - back;
    const cell = grid[Math.min(6, row)]?.[new Date(h).getHours()];
    if (!cell) return;
    cell.ms += totals[i] ?? 0;
    cell.state = h > now ? 'future' : 'past';
  });
  const rows = Array.from({ length: 7 }, (_, i) =>
    week ? start + (i * 24 + 12) * HOUR : now - (6 - i) * 24 * HOUR,
  );
  return { grid, rows, cursor: { row: Math.min(6, today), col: new Date(now).getHours() } };
}

export function weekReceipt(r: WeekResult): WeekReceipt {
  const { hourStarts, now } = r.window;
  const totals = hourStarts.map((_, i) => r.sessions.reduce((n, s) => n + (s.hours[i] ?? 0), 0));
  const all = totals.reduce((a, b) => a + b, 0);
  let busiest: WeekReceipt['busiest'] = null;
  let night = 0;
  hourStarts.forEach((h, i) => {
    const ms = totals[i] ?? 0;
    if (ms > (busiest?.ms ?? 0)) busiest = { at: h, ms };
    const hour = new Date(h).getHours();
    if (hour >= 22 || hour < 6) night += ms;
  });

  const byAgent = new Map<AgentKind, { ms: number; n: number }>();
  const usage = emptyUsage();
  let measured = false;
  const cats = new Map<ToolCategory, number>();
  const unreported = new Map<AgentKind, number>();
  const projects = new Set<string>();
  const work = { requests: 0, toolCalls: 0, subAgents: 0, failures: 0 };
  let longest: (typeof r.sessions)[number] | null = null;
  for (const s of r.sessions) {
    const f = s.inWindow;
    const a = byAgent.get(s.agent) ?? { ms: 0, n: 0 };
    byAgent.set(s.agent, { ms: a.ms + f.activeMs, n: a.n + 1 });
    work.requests += f.requests;
    work.toolCalls += f.toolCalls;
    work.subAgents += f.subAgents;
    work.failures += f.failures;
    for (const [c, n] of Object.entries(f.toolCats) as [ToolCategory, number][])
      cats.set(c, (cats.get(c) ?? 0) + n);
    if (f.measured) {
      measured = true;
      addUsage(usage, f.usage);
    } else unreported.set(s.agent, (unreported.get(s.agent) ?? 0) + 1);
    const project = printedProject(s.cwd, s.project);
    if (project) projects.add(project);
    if (!longest || f.activeMs > longest.inWindow.activeMs) longest = s;
  }

  // The tool categories as the session receipt groups them: the three largest, then the rest.
  const ranked = [...cats].filter(([c]) => c !== 'other').sort((a, b) => b[1] - a[1]);
  const other = (cats.get('other') ?? 0) + ranked.slice(3).reduce((n, [, k]) => n + k, 0);
  const categories = ranked.slice(0, 3).map(([category, count]) => ({ category, count }));
  if (other > 0) categories.push({ category: 'other', count: other });

  const clis = [...byAgent].sort((a, b) => b[1].ms - a[1].ms || b[1].n - a[1].n);
  const pct = shares(clis.map(([, v]) => v.ms));
  const ctx = contextSize(usage);
  const top = longest as (typeof r.sessions)[number] | null;
  return {
    kind: r.window.kind,
    start: hourStarts[0] ?? now,
    now,
    sessions: r.sessions.length,
    projects: projects.size,
    clis: clis.map(([agent]) => agent),
    agentMs: r.sessions.reduce((n, s) => n + s.inWindow.activeMs, 0),
    ...layGrid(r, totals),
    busiest,
    afterHours: all > 0 ? night / all : null,
    work: { ...work, categories },
    byCli: clis.map(([agent, v], i) => ({ agent, ms: v.ms, share: pct[i] ?? 0 })),
    longest: top
      ? {
          agent: top.agent,
          project: printedProject(top.cwd, top.project),
          title: top.title ? printedTitle(top.title) : null,
          ms: top.inWindow.activeMs,
        }
      : null,
    tokens: {
      measured,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      uncached: usage.input,
      output: usage.output,
      thinking: usage.thinking,
      cacheHit: ctx > 0 ? usage.cacheRead / ctx : null,
      total: totalTokens(usage),
    },
    unreported: [...unreported].sort((a, b) => b[1] - a[1]).map(([agent, n]) => ({ agent, n })),
  };
}

/** How far into this week `w` is printed: the quiet slip's window (under a day). */
export const weekAge = (w: WeekReceipt) => w.now - w.start;
export const QUIET_MS = 24 * HOUR;
