import type { AgentKind, SessionSummary } from '../../../src/core/model.js';
import { weekStart } from '../../../src/shared/week.js';

export interface SessionGroup {
  project: string;
  sessions: SessionSummary[];
}

/**
 * Running: busy, or blocked on the user's confirmation, which needs attention as much. The one
 * test of it, for the sidebar, Home's board, a row and whether more may still arrive.
 */
export const isRunning = (s: Pick<SessionSummary, 'live'>): boolean =>
  s.live === 'busy' || s.live === 'waiting';

const active = (s: SessionSummary) => Number(isRunning(s));

const busyFirst = (a: SessionSummary, b: SessionSummary) =>
  active(b) - active(a) || b.updatedAt.localeCompare(a.updatedAt);

/** The sidebar's live-state filter. Running holds busy and waiting: both need someone now. */
export type LiveFilter = 'running' | 'idle' | 'closed';

export const LIVE_FILTERS: readonly LiveFilter[] = ['running', 'idle', 'closed'];

/** Which live-state filter a session falls under; an unknown state counts as closed. */
export function liveFilterOf(s: SessionSummary): LiveFilter {
  if (isRunning(s)) return 'running';
  return s.live === 'idle' ? 'idle' : 'closed';
}

/** Background probe sessions (e.g. ClaudeBar's) are noise unless asked for. */
export const isListed = (s: Pick<SessionSummary, 'tags'>, showProbes = false): boolean =>
  showProbes || !s.tags?.includes('probe');

export interface GroupOptions {
  showProbes?: boolean;
  /** Only this agent's sessions. */
  agent?: AgentKind | null;
  /** Only sessions in this live state. */
  live?: LiveFilter | null;
  /** A session listed whatever the agent and live filters say: the open one keeps its row. */
  keep?: string | null;
}

/**
 * Sidebar grouping: by project, running sessions first (in groups and within them), then most
 * recently updated. `query` matches title or cwd, case-insensitively, and composes with the
 * agent and live filters.
 */
export function groupSessions(
  sessions: SessionSummary[],
  query: string,
  opts: GroupOptions = {},
): SessionGroup[] {
  const q = query.trim().toLowerCase();
  const filtered = (s: SessionSummary) =>
    s.id !== opts.keep &&
    ((opts.agent != null && s.agent !== opts.agent) ||
      (opts.live != null && liveFilterOf(s) !== opts.live));
  const matches = (s: SessionSummary) =>
    isListed(s, opts.showProbes) &&
    !filtered(s) &&
    (!q || (s.title ?? '').toLowerCase().includes(q) || (s.cwd ?? '').toLowerCase().includes(q));
  const groups = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    if (!matches(s)) continue;
    const list = groups.get(s.project);
    if (list) list.push(s);
    else groups.set(s.project, [s]);
  }
  const out = [...groups].map(([project, list]) => ({ project, sessions: list.sort(busyFirst) }));
  // Each group's first session is its "best" one after sorting, so it ranks the group.
  return out.sort((a, b) =>
    busyFirst(a.sessions[0] as SessionSummary, b.sessions[0] as SessionSummary),
  );
}

/** The sidebar's time groups (D, F7): by when a session was last active, the browser's calendar. */
export type TimeBucket = 'today' | 'yesterday' | 'week' | 'earlier';

export const TIME_BUCKETS: readonly TimeBucket[] = ['today', 'yesterday', 'week', 'earlier'];

/** Local midnight starting the day that holds `t`. */
const dayStart = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * Which time group a session last active at `updatedAt` falls in: today, yesterday, earlier this
 * week (from Monday 00:00, as Stats counts the week: empty on a Monday and a Tuesday) or earlier
 * still. A time a little ahead of this clock (a busy session's last write) is today; one that
 * cannot be read is earlier.
 */
export function timeBucket(updatedAt: string, now: number): TimeBucket {
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return 'earlier';
  const today = dayStart(now);
  if (t >= today) return 'today';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (t >= yesterday.getTime()) return 'yesterday';
  return t >= weekStart(now) ? 'week' : 'earlier';
}

/** A directory's segments, whichever separator, without empties: "C:\w\x\" and "/w/x/" alike. */
const segments = (dir: string) => dir.split(/[\\/]+/).filter(Boolean);

/**
 * The name each session's group reads as, from paths alone (no project file is read): its
 * directory's last segment, as the server names it, but with the parent directory's name before
 * it ("glassbox/weever") in two cases:
 * - a worktree: the parent is named like another session's own directory (the repository,
 *   `…/src/glassbox`) without being one itself (`…/work/glassbox/weever`). Worktrees whose
 *   repository has no session of its own keep their directory's name: from paths alone, a folder
 *   of worktrees and a folder of unrelated projects look the same;
 * - two directories that would read alike (`…/work/api` and `…/home/api`), which take as many
 *   parent segments as tell them apart.
 * A session without a directory keeps the server's name.
 */
export function groupNames(
  sessions: readonly Pick<SessionSummary, 'cwd' | 'project'>[],
): (s: Pick<SessionSummary, 'cwd' | 'project'>) => string {
  // Each distinct directory once, by its segments joined: "/w/x" and "/w/x/" are one.
  const dirs = new Map<string, string[]>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const segs = segments(s.cwd);
    dirs.set(segs.join('/'), segs);
  }
  const bases = new Map<string, number>();
  for (const segs of dirs.values()) {
    const b = segs.at(-1) ?? '';
    bases.set(b, (bases.get(b) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const [canon, segs] of dirs) {
    const base = segs.at(-1) ?? '';
    const parent = segs.at(-2);
    const worktree =
      parent !== undefined &&
      !dirs.has(segs.slice(0, -1).join('/')) &&
      (bases.get(parent) ?? 0) - (parent === base ? 1 : 0) > 0;
    names.set(canon, worktree ? `${parent}/${base}` : base);
  }
  const alike = new Map<string, string[]>();
  for (const [canon, name] of names) alike.set(name, [...(alike.get(name) ?? []), canon]);
  for (const canons of alike.values()) {
    if (canons.length < 2) continue;
    const deepest = Math.max(...canons.map((c) => dirs.get(c)?.length ?? 0));
    for (let k = 2; k <= deepest; k++) {
      const tails = canons.map((c) => (dirs.get(c) ?? []).slice(-k).join('/'));
      if (new Set(tails).size === canons.length || k === deepest) {
        canons.forEach((c, i) => {
          names.set(c, tails[i] as string);
        });
        break;
      }
    }
  }
  return (s) => (s.cwd && names.get(segments(s.cwd).join('/'))) || s.project;
}

/** How many closed sessions a group lists before "N more". */
export const CLOSED_SHOWN = 5;

/**
 * A group's rows as first listed: every running and idle session, the 5 most recently updated
 * closed ones (an unknown state counts as closed, as the state filter counts it) and `keep`, the
 * open session; then the rest, which "N more" unfolds. The order is the group's own, so a closed
 * session keeps its place among the idle ones.
 */
export function foldClosed(
  sessions: readonly SessionSummary[],
  keep: string | null = null,
): { shown: SessionSummary[]; more: SessionSummary[] } {
  const shown: SessionSummary[] = [];
  const more: SessionSummary[] = [];
  let closed = 0;
  for (const s of sessions) {
    const isClosed = liveFilterOf(s) === 'closed';
    if (isClosed) closed++;
    (isClosed && closed > CLOSED_SHOWN && s.id !== keep ? more : shown).push(s);
  }
  return { shown, more };
}
