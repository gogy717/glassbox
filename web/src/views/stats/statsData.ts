/**
 * The Stats page's figures (D4), from the same listed sessions the weekly receipt counts: the
 * receipt's own `weekReceipt` for everything the slip prints (N6), and here only what the page
 * adds to it: the projects, the longest sessions, an hour's sessions, a CLI's or a project's own
 * grid. Titles are the sessions' own (the page stays on this machine); projects are printed as
 * the receipt counts them, so "6 projects" lists six.
 */
import type { AgentKind } from '../../../../src/core/model.js';
import { crossings, type RepoCrossing } from '../../../../src/shared/crossing.js';
import type { WeekResult, WeekSession, WeekWindowKind } from '../../../../src/shared/week.js';
import { clock, day, durationParts, partsText, shortDay } from '../../components/receipt/format';
import { projectNames } from '../../components/receipt/printed';
import {
  type GridCell,
  listedOnly,
  type WeekReceipt,
  weekReceipt,
} from '../../components/receipt/week';
import type { Locale } from '../../i18n';
import { agentName } from '../../lib/agent-names';
import { DEFAULT_PRICES, type PriceTable } from '../../lib/prices';
import { st } from './strings';

/** A window's result as the page counts it, and the receipt drawn from it. */
export interface StatsWeek {
  /** Without the sessions the sidebar hides. */
  result: WeekResult;
  receipt: WeekReceipt;
  /** The price table its receipt's API equivalent was worked out with; an isolate keeps it. */
  prices: PriceTable;
}

/** `prices`: the API price table for the tokens' API equivalent (the person's, from Settings). */
export function statsWeek(
  result: WeekResult,
  showProbes: boolean,
  prices: PriceTable = DEFAULT_PRICES,
): StatsWeek {
  const listed = listedOnly(result, showProbes);
  return { result: listed, receipt: weekReceipt(listed, prices), prices };
}

/** A session as a row of a card: what it is, and the time that ranks it there. */
export interface SessionLine {
  id: string;
  agent: AgentKind;
  title: string | null;
  project: string | null;
  ms: number;
}

/**
 * Each session's project name, as the session list groups them (`projectNames`): a
 * repository's worktrees are one project. Worked out once per week result.
 */
const namers = new WeakMap<WeekResult, (s: WeekSession) => string | null>();
export function projectOf(w: StatsWeek, s: WeekSession): string | null {
  let name = namers.get(w.result);
  if (!name) {
    name = projectNames(w.result.sessions);
    namers.set(w.result, name);
  }
  return name(s);
}

const lineOf = (w: StatsWeek, s: WeekSession, ms: number): SessionLine => ({
  id: s.id,
  agent: s.agent,
  title: s.title,
  project: projectOf(w, s),
  ms,
});

/** The projects by agent time, each with its sessions: Top projects. */
export function topProjects(w: StatsWeek, n = 5): { name: string; ms: number; sessions: number }[] {
  const by = new Map<string, { name: string; ms: number; sessions: number }>();
  for (const s of w.result.sessions) {
    const name = projectOf(w, s);
    if (!name) continue;
    const p = by.get(name) ?? { name, ms: 0, sessions: 0 };
    p.ms += s.inWindow.agentMs;
    p.sessions += 1;
    by.set(name, p);
  }
  return [...by.values()].sort((a, b) => b.ms - a.ms || b.sessions - a.sessions).slice(0, n);
}

/**
 * The window's crossings: the repositories worked on in two or more worktrees, and the files more
 * than one of those changed (`crossings`), each repository named as Top projects names it.
 * Worked out once per week result.
 */
const crossed = new WeakMap<WeekResult, RepoCrossing[]>();
export function crossingOf(w: StatsWeek): RepoCrossing[] {
  let found = crossed.get(w.result);
  if (!found) {
    const byRoot = new Map<string, WeekSession>();
    for (const s of w.result.sessions)
      if (s.repo && !byRoot.has(s.repo.root)) byRoot.set(s.repo.root, s);
    found = crossings(
      w.result.sessions.map((s) => ({ id: s.id, repo: s.repo, files: s.inWindow.files })),
    ).map((r) => {
      const s = byRoot.get(r.root);
      return { ...r, name: (s && projectOf(w, s)) || r.name };
    });
    crossed.set(w.result, found);
  }
  return found;
}

/** The sessions that worked longest by their own clock (session time, as LONGEST): five. */
export function longestSessions(w: StatsWeek, n = 5): SessionLine[] {
  return w.result.sessions
    .filter((s) => s.inWindow.activeMs > 0)
    .sort((a, b) => b.inWindow.activeMs - a.inWindow.activeMs)
    .slice(0, n)
    .map((s) => lineOf(w, s, s.inWindow.activeMs));
}

/** Where the busiest hour sits in the grid, selected when the page opens; null with none. */
export function busiestCell(w: StatsWeek): { row: number; col: number } | null {
  const { busiest } = w.receipt;
  const i = busiest ? w.result.window.hourStarts.indexOf(busiest.at) : -1;
  for (const [row, cells] of w.receipt.grid.entries())
    for (const [col, cell] of cells.entries()) if (cell.hours.includes(i)) return { row, col };
  return null;
}

/** For each hour of the window, the sessions that worked in it and for how long: built once. */
export type HourIndex = { s: WeekSession; ms: number }[][];

export function indexHours(w: StatsWeek): HourIndex {
  const index: HourIndex = w.result.window.hourStarts.map(() => []);
  for (const s of w.result.sessions)
    s.hours.forEach((ms, i) => {
      if (ms > 0) index[i]?.push({ s, ms });
    });
  return index;
}

/**
 * The hour a cell holds (two, where a change of the clocks repeats one): when it starts, its
 * agent time, its sessions most minutes first, and the CLI that worked most in it. From the
 * hours' index, so a cell reads only its own sessions.
 */
export function hourOfCell(w: StatsWeek, cell: GridCell, index: HourIndex = indexHours(w)) {
  const { hourStarts } = w.result.window;
  const worked = new Map<WeekSession, number>();
  for (const i of cell.hours)
    for (const x of index[i] ?? []) worked.set(x.s, (worked.get(x.s) ?? 0) + x.ms);
  const sessions = [...worked].map(([s, ms]) => lineOf(w, s, ms)).sort((a, b) => b.ms - a.ms);
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

/** The same CLI, or the same project: by what it is, not by the name it prints. */
export const sameIsolate = (a: Isolate | null, b: Isolate | null): boolean =>
  !!a &&
  !!b &&
  ('cli' in a ? 'cli' in b && a.cli === b.cli : 'project' in b && a.project === b.project);

export function isolated(w: StatsWeek, by: Isolate): StatsWeek {
  const keep = (s: WeekSession) =>
    'cli' in by ? s.agent === by.cli : projectOf(w, s) === by.project;
  const result = { ...w.result, sessions: w.result.sessions.filter(keep) };
  return { result, receipt: weekReceipt(result, w.prices), prices: w.prices };
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

const WEEKDAY: Record<Locale, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-US', { weekday: 'short' }),
  zh: new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }),
};

/**
 * An hour of the grid, from its start to the next: "Thu 23:00 – 00:00". The last 7 days hold
 * today's weekday twice, so there it is dated: "Sat 17 Oct 21:00 – 22:00".
 */
export const hourSpan = (start: number, kind: WeekWindowKind, L: Locale) =>
  `${kind === 'week' ? WEEKDAY[L].format(start) : shortDay(start, L)} ${clock(start)} – ${clock(start + 3_600_000)}`;

/** What a cell says in its tip and to a screen reader: its hour, then what was done in it. */
export interface CellLabel {
  title: string;
  line: string;
}

/** Every cell's label, 7 × 24, worked out once for the week drawn (not on each hover). */
export function cellLabels(w: StatsWeek, kind: WeekWindowKind, L: Locale): CellLabel[][] {
  const index = indexHours(w);
  return w.receipt.grid.map((cells) =>
    cells.map((cell) => {
      const hour = hourOfCell(w, cell, index);
      const title = hour.start !== null ? hourSpan(hour.start, kind, L) : '—';
      if (cell.state === 'out') return { title, line: '—' };
      if (cell.state === 'future') return { title, line: st(L, 'cellAhead') };
      if (!hour.topCli) return { title, line: st(L, 'cellIdle') };
      return {
        title,
        line: st(L, 'cell', {
          time: timeText(hour.ms, L),
          n: hour.sessions.length,
          cli: agentName(hour.topCli.agent),
          cliTime: timeText(hour.topCli.ms, L),
        }),
      };
    }),
  );
}
