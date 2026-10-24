/**
 * The Stats page's figures (D4), from the same listed sessions the weekly receipt counts: the
 * receipt's own `weekReceipt` for everything the slip prints (N6), and here only what the page
 * adds to it: the projects, the longest sessions, an hour's sessions, a CLI's or a project's own
 * grid. Titles are the sessions' own (the page stays on this machine); projects are printed as
 * the receipt counts them, so "6 projects" lists six.
 */
import type { AgentKind } from '../../../../src/core/model.js';
import type { WeekResult, WeekSession, WeekWindowKind } from '../../../../src/shared/week.js';
import { clock, day, durationParts, partsText, shortDay } from '../../components/receipt/format';
import { printedProject } from '../../components/receipt/printed';
import {
  type GridCell,
  listedOnly,
  type WeekReceipt,
  weekReceipt,
} from '../../components/receipt/week';
import type { Locale } from '../../i18n';

/** A window's result as the page counts it, and the receipt drawn from it. */
export interface StatsWeek {
  /** Without the sessions the sidebar hides. */
  result: WeekResult;
  receipt: WeekReceipt;
}

export function statsWeek(result: WeekResult, showProbes: boolean): StatsWeek {
  const listed = listedOnly(result, showProbes);
  return { result: listed, receipt: weekReceipt(listed) };
}

/** A session as a row of a card: what it is, and the time that ranks it there. */
export interface SessionLine {
  id: string;
  agent: AgentKind;
  title: string | null;
  project: string | null;
  ms: number;
}

const lineOf = (s: WeekSession, ms: number): SessionLine => ({
  id: s.id,
  agent: s.agent,
  title: s.title,
  project: printedProject(s.cwd, s.project),
  ms,
});

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

/** The projects by agent time, each with its sessions: Top projects. */
export function topProjects(w: StatsWeek, n = 5): { name: string; ms: number; sessions: number }[] {
  const by = new Map<string, { name: string; ms: number; sessions: number }>();
  for (const s of w.result.sessions) {
    const name = printedProject(s.cwd, s.project);
    if (!name) continue;
    const p = by.get(name) ?? { name, ms: 0, sessions: 0 };
    p.ms += s.inWindow.agentMs;
    p.sessions += 1;
    by.set(name, p);
  }
  return [...by.values()].sort((a, b) => b.ms - a.ms || b.sessions - a.sessions).slice(0, n);
}

/** The sessions that worked longest by their own clock (session time, as LONGEST): five. */
export function longestSessions(w: StatsWeek, n = 5): SessionLine[] {
  return w.result.sessions
    .filter((s) => s.inWindow.activeMs > 0)
    .sort((a, b) => b.inWindow.activeMs - a.inWindow.activeMs)
    .slice(0, n)
    .map((s) => lineOf(s, s.inWindow.activeMs));
}

/** Where the busiest hour sits in the grid, selected when the page opens; null with none. */
export function busiestCell(w: StatsWeek): { row: number; col: number } | null {
  const { busiest } = w.receipt;
  const i = busiest ? w.result.window.hourStarts.indexOf(busiest.at) : -1;
  for (const [row, cells] of w.receipt.grid.entries())
    for (const [col, cell] of cells.entries()) if (cell.hours.includes(i)) return { row, col };
  return null;
}

/**
 * The hour a cell holds (two, where a change of the clocks repeats one): when it starts, its
 * agent time, its sessions most minutes first, and the CLI that worked most in it.
 */
export function hourOfCell(w: StatsWeek, cell: GridCell) {
  const { hourStarts } = w.result.window;
  const sessions = w.result.sessions
    .map((s) => lineOf(s, sum(cell.hours.map((i) => s.hours[i] ?? 0))))
    .filter((s) => s.ms > 0)
    .sort((a, b) => b.ms - a.ms);
  const byCli = new Map<AgentKind, number>();
  for (const s of sessions) byCli.set(s.agent, (byCli.get(s.agent) ?? 0) + s.ms);
  const top = [...byCli].sort((a, b) => b[1] - a[1])[0];
  return {
    start: hourStarts[cell.hours[0] ?? -1] ?? null,
    ms: cell.ms,
    sessions,
    topCli: top ? { agent: top[0], ms: top[1] } : null,
  };
}

/** The grid as one CLI's sessions, or one project's, drew it alone: isolate. */
export type Isolate = { cli: AgentKind } | { project: string };

export function isolated(w: StatsWeek, by: Isolate): StatsWeek {
  const keep = (s: WeekSession) =>
    'cli' in by ? s.agent === by.cli : printedProject(s.cwd, s.project) === by.project;
  const result = { ...w.result, sessions: w.result.sessions.filter(keep) };
  return { result, receipt: weekReceipt(result) };
}

/** A time as the receipt prints it ("23h 41m", "38m", "4m 12s"); "—" for none at all. */
export const timeText = (ms: number, L: Locale) => (ms > 0 ? partsText(durationParts(ms, L)) : '—');

/**
 * The window from its first hour to when its data is from, as the receipt's line has it without
 * the window's name (the switch beside it says that): "Mon 19 Oct → Sat 24 Oct · 20:41",
 * "Sat 17 Oct 21:00 → Sat 24 Oct · 20:41"; on its first day "Mon 19 Oct 2026, 00:00 → 00:05".
 */
export function spanLine(kind: WeekWindowKind, start: number, end: number, L: Locale): string {
  const at = L === 'zh' ? ` ${clock(end)}` : ` · ${clock(end)}`;
  if (kind === '7d') return `${shortDay(start, L)} ${clock(start)} → ${shortDay(end, L)}${at}`;
  if (new Date(start).toDateString() === new Date(end).toDateString())
    return `${day(start, L)}${L === 'zh' ? '' : ','} ${clock(start)} → ${clock(end)}`;
  return `${shortDay(start, L)} → ${shortDay(end, L)}${at}`;
}

const weekday = (t: number, L: Locale) =>
  new Intl.DateTimeFormat(L === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short' }).format(t);

/**
 * An hour of the grid, from its start to the next: "Thu 23:00 – 00:00". The last 7 days hold
 * today's weekday twice, so there it is dated: "Sat 17 Oct 21:00 – 22:00".
 */
export const hourSpan = (start: number, kind: WeekWindowKind, L: Locale) =>
  `${kind === 'week' ? weekday(start, L) : shortDay(start, L)} ${clock(start)} – ${clock(start + 3_600_000)}`;
