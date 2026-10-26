/**
 * What the weekly receipt says, from `/api/week`'s result: the server cut every session to the
 * window; here they are only added up, ranked and laid out. Agent time is every agent's own
 * turns added up and the grid's sum (DR7); the session time beside it (the main agents' turns),
 * the longest session and WORK and TOKENS keep the session receipt's meaning, so a week of one
 * session prints that session's numbers. The receipt ends at `asOf`, when it was put together.
 */
import type { AgentKind, TokenUsage } from '../../../../src/core/model.js';
import { addUsage, contextSize, emptyUsage, totalTokens } from '../../../../src/core/usage.js';
import type { ToolCategory } from '../../../../src/shared/tool-category.js';
import type { WeekResult, WeekWindowKind } from '../../../../src/shared/week.js';
import type { Locale } from '../../i18n';
import { agentName } from '../../lib/agent-names';
import { costByModel, DEFAULT_PRICES, type PriceTable } from '../../lib/prices';
import { isListed } from '../../lib/sessions';
import { printedProject, printedTitle } from './printed';
import { apportion, shares } from './rows';
import type { TokenFigures } from './slip';
import { type ReceiptKey, rt } from './strings';

const HOUR = 3_600_000;

export interface GridCell {
  /** Agent time in the hour (ms). */
  ms: number;
  /** 'future': after the receipt's end, outlined; 'out': not in the window, not drawn. */
  state: 'past' | 'future' | 'out';
  /**
   * The window's hours it holds, as indices into `hourStarts`: one, two where a change of the
   * clocks repeats an hour, none out of the window. The Stats page's hour card reads them.
   */
  hours: number[];
}

export interface WeekReceipt {
  kind: WeekWindowKind;
  /** First hour of the window, and when the receipt ends: `asOf`, when its data is from. */
  start: number;
  now: number;
  sessions: number;
  projects: number;
  /** CLIs with activity, the most agent time first. */
  clis: AgentKind[];
  /** The hero: every agent's own turns added up, the grid's sum; 0 when nothing was timed. */
  agentMs: number;
  /** The main agents' turns, added up: the session receipts' ACTIVE TIME, printed beside it. */
  sessionMs: number;
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
  /**
   * Agent time by CLI, most first: `units` of the hero's own unit (`cliUnit`: whole minutes from
   * ten minutes up, seconds below), shared out so the rows add up to the hero as printed (DR10);
   * whole percents adding up to 100 over the CLIs of 1% or more, '<1' for the others that did
   * anything (DR4); a CLI with no time at all last, no share (DR8).
   */
  byCli: { agent: AgentKind; ms: number; units: number; share: number | '<1' | null }[];
  cliUnit: 'min' | 's';
  /** The session that worked longest by its own clock (its session time); none if none did. */
  longest: { agent: AgentKind; project: string | null; title: string | null; ms: number } | null;
  tokens: TokenFigures;
  /** Sessions that report no usage, by CLI: the TOKENS note. */
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
 * The 7 × 24 grid, and the cursor after the hour the receipt ends in. This week: Monday to
 * Sunday by date and hour, the hours after the end outlined. The last 7 days: its 168 hours in
 * order (R23), so a day that changes the clocks neither doubles an hour nor leaves a hole; today's
 * row ends with them, its hours up to now on the left, the first hours of the window (the same
 * weekday a week ago) on the right (R20).
 */
function layGrid(r: WeekResult, totals: number[], end: number) {
  const { hourStarts } = r.window;
  const grid: GridCell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, (): GridCell => ({ ms: 0, state: 'out', hours: [] })),
  );
  const start = hourStarts[0] ?? end;
  const endHour = hourStarts.findLastIndex((h) => h <= end);
  let place: (i: number, h: number) => { row: number; col: number };
  let rows: number[];
  if (r.window.kind === 'week') {
    place = (_i, h) => ({ row: Math.min(6, daysBetween(start, h)), col: new Date(h).getHours() });
    rows = Array.from({ length: 7 }, (_, i) => start + (i * 24 + 12) * HOUR);
  } else {
    const n = hourStarts.length;
    const c = new Date(hourStarts[n - 1] ?? end).getHours();
    const head = Math.max(0, n - 144 - (c + 1));
    place = (i) =>
      i < head
        ? { row: 6, col: c + 1 + i }
        : i < head + 144
          ? { row: Math.floor((i - head) / 24), col: (i - head) % 24 }
          : { row: 6, col: i - head - 144 };
    rows = Array.from({ length: 7 }, (_, row) =>
      row === 6 ? (hourStarts[n - 1] ?? end) : (hourStarts[head + row * 24 + 12] ?? end),
    );
  }
  hourStarts.forEach((h, i) => {
    const at = place(i, h);
    const cell = grid[at.row]?.[at.col];
    if (!cell) return;
    cell.ms += totals[i] ?? 0;
    cell.hours.push(i);
    // Only an empty hour after the end is outlined: an hour with ink is never (DR9), nor a cell
    // that also holds an hour before the end (the hour a change of the clocks repeats).
    if (h <= end || cell.ms > 0) cell.state = 'past';
    else if (cell.state === 'out') cell.state = 'future';
  });
  const cursor = place(Math.max(0, endHour), hourStarts[Math.max(0, endHour)] ?? end);
  return { grid, rows, cursor };
}

/**
 * The result without the sessions the sidebar hides: probes, unless it shows them (A1). The
 * receipt and the Stats page both count from it, so they print the same numbers (N6).
 */
export const listedOnly = (r: WeekResult, showProbes: boolean): WeekResult => ({
  ...r,
  sessions: r.sessions.filter((s) => isListed(s, showProbes)),
});

/** `prices`: the API price table for the API equivalent (the person's, from Settings). */
export function weekReceipt(r: WeekResult, prices: PriceTable = DEFAULT_PRICES): WeekReceipt {
  const { hourStarts } = r.window;
  const end = r.asOf;
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
  const usageByModel: Record<string, TokenUsage> = {};
  let measured = false;
  const cats = new Map<ToolCategory, number>();
  const unreported = new Map<AgentKind, number>();
  const projects = new Set<string>();
  const work = { requests: 0, toolCalls: 0, subAgents: 0, failures: 0 };
  let longest: (typeof r.sessions)[number] | null = null;
  for (const s of r.sessions) {
    const f = s.inWindow;
    const a = byAgent.get(s.agent) ?? { ms: 0, n: 0 };
    byAgent.set(s.agent, { ms: a.ms + f.agentMs, n: a.n + 1 });
    work.requests += f.requests;
    work.toolCalls += f.toolCalls;
    work.subAgents += f.subAgents;
    work.failures += f.failures;
    for (const [c, n] of Object.entries(f.toolCats) as [ToolCategory, number][])
      cats.set(c, (cats.get(c) ?? 0) + n);
    if (s.reportsUsage) {
      measured = true;
      addUsage(usage, f.usage);
      for (const [model, u] of Object.entries(f.usageByModel)) {
        const held = usageByModel[model];
        if (held) addUsage(held, u);
        else usageByModel[model] = addUsage(emptyUsage(), u);
      }
    } else unreported.set(s.agent, (unreported.get(s.agent) ?? 0) + 1);
    const project = printedProject(s.cwd, s.project);
    if (project) projects.add(project);
    if (f.activeMs > (longest?.inWindow.activeMs ?? 0)) longest = s;
  }

  // The tool categories as the session receipt groups them: the three largest, then the rest.
  const ranked = [...cats].filter(([c]) => c !== 'other').sort((a, b) => b[1] - a[1]);
  const other = (cats.get('other') ?? 0) + ranked.slice(3).reduce((n, [, k]) => n + k, 0);
  const categories = ranked.slice(0, 3).map(([category, count]) => ({ category, count }));
  if (other > 0) categories.push({ category: 'other', count: other });

  // By CLI: the hero's printed minutes (or seconds) shared out over the CLIs; the CLIs of 1% or
  // more share 100 percent between them, the rest print "<1%"; one with no time, no share.
  const clis = [...byAgent].sort((a, b) => b[1].ms - a[1].ms || b[1].n - a[1].n);
  const cliTotal = clis.reduce((n, [, v]) => n + v.ms, 0);
  const cliUnit = cliTotal >= 10 * 60_000 ? 'min' : 's';
  const unitMs = cliUnit === 'min' ? 60_000 : 1000;
  const units = apportion(
    clis.map(([, v]) => v.ms),
    Math.floor(cliTotal / unitMs),
  );
  const big = clis.filter(([, v]) => cliTotal > 0 && v.ms / cliTotal >= 0.01);
  const pct = new Map(big.map(([agent], i) => [agent, shares(big.map(([, v]) => v.ms))[i] ?? 0]));
  const ctx = contextSize(usage);
  const cost = costByModel(usageByModel, prices);
  const top = longest as (typeof r.sessions)[number] | null;
  return {
    kind: r.window.kind,
    start: hourStarts[0] ?? end,
    now: end,
    sessions: r.sessions.length,
    projects: projects.size,
    clis: clis.map(([agent]) => agent),
    agentMs: all,
    sessionMs: r.sessions.reduce((n, s) => n + s.inWindow.activeMs, 0),
    ...layGrid(r, totals, end),
    busiest,
    afterHours: all > 0 ? night / all : null,
    work: { ...work, categories },
    byCli: clis.map(([agent, v], i) => ({
      agent,
      ms: v.ms,
      units: units[i] ?? 0,
      share: v.ms > 0 ? (pct.get(agent) ?? '<1') : null,
    })),
    cliUnit,
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
      cost,
    },
    unreported: [...unreported].sort((a, b) => b[1] - a[1]).map(([agent, n]) => ({ agent, n })),
  };
}

/** How far into this week the receipt ends. */
export const weekAge = (w: WeekReceipt) => w.now - w.start;
/** Under a day into the week, the dialog says what the last 7 days hold. */
export const HINT_MS = 24 * HOUR;
/**
 * Under half an hour of agent time this week and under 20 model calls, the quiet slip, with the
 * way out (DR2, R26). A week that was not timed (only Codex, say) has its calls to print.
 */
export const QUIET_MS = 30 * 60_000;
export const QUIET_CALLS = 20;
export const isQuiet = (w: WeekReceipt) =>
  w.kind === 'week' && w.sessions > 0 && w.agentMs < QUIET_MS && w.work.requests < QUIET_CALLS;

/** The line under LONGEST: its project and title, or only its CLI when names are withheld. */
export function longestLine(
  l: NonNullable<WeekReceipt['longest']>,
  hideNames: boolean,
  w: (key: ReceiptKey) => string,
): string {
  if (hideNames) return `${agentName(l.agent)} · ${w('aSession')}`;
  return `${l.project ? `${l.project} / ` : ''}${l.title ?? w('untitled')}`;
}

/**
 * The TOKENS note on sessions that report no usage, as full as `fits` allows (DR3): "Codex 11 ·
 * Grok 6 sessions", then without "sessions", then "17 sessions · 2 CLIs". Never cut, never
 * wrapped; null when there is nothing to note (none missing, or none reported at all).
 */
export function unreportedLine(
  d: WeekReceipt,
  L: Locale,
  fits: (line: string) => boolean,
): string | null {
  if (!d.tokens.measured || d.unreported.length === 0) return null;
  const n = d.unreported.reduce((a, u) => a + u.n, 0);
  const each = d.unreported.map((u) => `${agentName(u.agent)} ${u.n}`).join(' · ');
  const tries = [
    rt(L, 'notReportedBy', { who: `${each} ${rt(L, 'sessionsNoun', { n })}` }),
    rt(L, 'notReportedBy', { who: each }),
    rt(L, 'notReportedFold', { n, c: d.unreported.length }),
  ];
  return tries.find(fits) ?? (tries.at(-1) as string);
}
