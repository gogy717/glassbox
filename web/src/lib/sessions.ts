import type { AgentKind, SessionSummary } from '../../../src/core/model.js';
import { weekStart } from '../../../src/shared/week.js';

/** How the sidebar groups sessions: by project (the default), or by when each was last active. */
export type GroupBy = 'project' | 'time';

/** The pinned group's key. Project names are directory names, so none starts with a slash. */
export const PINNED_KEY = '/pinned';

export type SessionGroup =
  | { kind: 'pinned'; key: typeof PINNED_KEY; sessions: SessionSummary[] }
  | {
      kind: 'project';
      /** The project's name (`groupNames`), which is the group's key. */
      key: string;
      /**
       * The directory every session of the group ran in, when they share one; else the
       * repository's root when the group is a repository's.
       */
      cwd: string | null;
      /**
       * The group's working trees, when its sessions come from more than one of one repository
       * (`worktreesOf`): the main one first, then the others, running first. Null otherwise.
       */
      worktrees: Worktree[] | null;
      sessions: SessionSummary[];
    }
  | { kind: 'time'; key: `/${TimeBucket}`; bucket: TimeBucket; sessions: SessionSummary[] };

/** One working tree of a repository group and its sessions, in the group's order. */
export interface Worktree {
  /** The working tree's directory, as its sessions' `repo.dir`. */
  dir: string;
  /** The directory's last segment: the repository's name for the main one. */
  name: string;
  /** The repository's main working tree, whose `.git` is a directory. */
  main: boolean;
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
  /** By project (the default), or by when each session was last active, counted from `now`. */
  groupBy?: GroupBy;
  now?: number;
  /** Pinned sessions, by id in the order pinned: a first group of their own, in that order. */
  pinned?: readonly string[];
}

/**
 * Sidebar grouping: the pinned sessions first, in the order pinned; then by project, named from
 * paths (`groupNames`), the groups with a running session first and then the most recently
 * updated; or by time, today to earlier. Within a group, running sessions first, then the most
 * recently updated. `query` matches title or cwd, case-insensitively, and composes with the agent
 * and live filters; pins answer to them like any row.
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
  // Names come from every session, not from what the search and the filters leave: a group does
  // not read differently while typing.
  const nameOf = groupNames(sessions);
  const now = opts.now ?? Date.now();
  const keyOf = (s: SessionSummary) =>
    opts.groupBy === 'time' ? `/${timeBucket(s.updatedAt, now)}` : nameOf(s);
  const pinnedIds = new Set(opts.pinned ?? []);
  const pinnedFound = new Map<string, SessionSummary>();
  const groups = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    if (!matches(s)) continue;
    if (pinnedIds.has(s.id)) {
      pinnedFound.set(s.id, s);
      continue;
    }
    const key = keyOf(s);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const out: SessionGroup[] = [];
  const pins = (opts.pinned ?? []).flatMap((id) => {
    const s = pinnedFound.get(id);
    return s ? [s] : [];
  });
  if (pins.length > 0) out.push({ kind: 'pinned', key: PINNED_KEY, sessions: pins });
  if (opts.groupBy === 'time') {
    for (const bucket of TIME_BUCKETS) {
      const list = groups.get(`/${bucket}`);
      if (list)
        out.push({ kind: 'time', key: `/${bucket}`, bucket, sessions: list.sort(busyFirst) });
    }
    return out;
  }
  const projects = [...groups].map(([key, list]) => {
    const sorted = list.sort(busyFirst);
    const root = sorted.find((s) => s.repo)?.repo?.root ?? null;
    return {
      kind: 'project' as const,
      key,
      cwd: sharedCwd(sorted) ?? root,
      worktrees: worktreesOf(sorted),
      sessions: sorted,
    };
  });
  // Each group's first session is its "best" one after sorting, so it ranks the group.
  projects.sort((a, b) =>
    busyFirst(a.sessions[0] as SessionSummary, b.sessions[0] as SessionSummary),
  );
  return [...out, ...projects];
}

/**
 * A repository group's working trees, when its sessions ran in more than one: the main one
 * first, then the others as their first (running-first) session ranks them. Null for one tree
 * or when a session's repository is not known: nothing to split by.
 */
export function worktreesOf(sessions: readonly SessionSummary[]): Worktree[] | null {
  const trees = new Map<string, Worktree>();
  for (const s of sessions) {
    if (!s.repo) return null;
    const key = segments(s.repo.dir).join('/');
    const tree = trees.get(key);
    if (tree) tree.sessions.push(s);
    else
      trees.set(key, {
        dir: s.repo.dir,
        name: segments(s.repo.dir).at(-1) ?? s.repo.name,
        main: key === segments(s.repo.root).join('/'),
        sessions: [s],
      });
  }
  if (trees.size < 2) return null;
  return [...trees.values()].sort(
    (a, b) =>
      Number(b.main) - Number(a.main) ||
      busyFirst(a.sessions[0] as SessionSummary, b.sessions[0] as SessionSummary),
  );
}

/** The directory the sessions ran in, when every one that names a directory names the same. */
function sharedCwd(sessions: readonly SessionSummary[]): string | null {
  let shared: string | null = null;
  for (const s of sessions) {
    if (!s.cwd) continue;
    if (shared === null) shared = s.cwd;
    else if (segments(s.cwd).join('/') !== segments(shared).join('/')) return null;
  }
  return shared;
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

type Named = Pick<SessionSummary, 'cwd' | 'project' | 'repo'>;

/**
 * What a session groups by: its repository's root when the server read one (every worktree of
 * a repository gathers under it, wherever it is), else its own directory; null without either.
 */
const identityOf = (s: Named): string[] | null =>
  s.repo ? segments(s.repo.root) : s.cwd ? segments(s.cwd) : null;

/**
 * The name each session's group reads as (no project file is read): the repository's name
 * when the server knows the repository, else its directory's last segment, as the server names
 * it, but with the parent directory's name before it ("glassbox/weever") in two cases:
 * - a worktree the server could not tell: the parent is named like another session's own
 *   directory (the repository, `…/src/glassbox`) without being one itself
 *   (`…/work/glassbox/weever`). Worktrees whose repository has no session of its own keep their
 *   directory's name: from paths alone, a folder of worktrees and a folder of unrelated projects
 *   look the same;
 * - two directories (or repositories) that would read alike (`…/work/api` and `…/home/api`),
 *   which take as many parent segments as tell them apart.
 * A session without a directory keeps the server's name.
 */
export function groupNames(sessions: readonly Named[]): (s: Named) => string {
  // Each distinct identity once, by its segments joined: "/w/x" and "/w/x/" are one.
  const dirs = new Map<string, string[]>();
  for (const s of sessions) {
    const segs = identityOf(s);
    if (segs) dirs.set(segs.join('/'), segs);
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
  return (s) => {
    const segs = identityOf(s);
    return (segs && names.get(segs.join('/'))) || s.project;
  };
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
