import type { AgentKind, SessionSummary } from '../../../src/core/model.js';
import { weekStart } from '../../../src/shared/week.js';

/** How the sidebar groups sessions: by project (the default), or by when each was last active. */
export type GroupBy = 'project' | 'time';

/** The pinned group's key; a project group's starts with `/p/` or `/n/`, a time group's is its bucket. */
export const PINNED_KEY = '/pinned';

export type SessionGroup =
  | { kind: 'pinned'; key: typeof PINNED_KEY; sessions: SessionSummary[] }
  | {
      kind: 'project';
      /**
       * What the group gathers by, which does not change with the rest of the list (folds are
       * kept by it): `projectKey` of the repository's root or the directory, or `/n/` and the
       * server's name for sessions with neither.
       */
      key: string;
      /** The name the group reads as (`groupNames`), which can change as the list does. */
      name: string;
      /**
       * The directory every session of the group ran in, when they share one; else the
       * repository's root when the group is a repository's.
       */
      cwd: string | null;
      /**
       * The group's working trees, when its sessions come from more than one of one repository
       * (`worktreesOf`), removed ones included: the main one first, then the others, running
       * first. Null otherwise.
       */
      worktrees: Worktree[] | null;
      sessions: SessionSummary[];
    }
  | { kind: 'time'; key: `/${TimeBucket}`; bucket: TimeBucket; sessions: SessionSummary[] };

/** One working tree of a repository group and its sessions, in the group's order. */
export interface Worktree {
  /** The working tree's directory: its sessions' `repo.dir`, or `cwd` for a removed one. */
  dir: string;
  /** The directory's last segment: the repository's name for the main one. */
  name: string;
  /** The repository's main working tree, whose `.git` is a directory. */
  main: boolean;
  /** Removed: its sessions have no repository and the server found nothing at their directory. */
  gone: boolean;
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
 * Sidebar grouping: the pinned sessions first, in the order pinned; then by project (`homesOf`),
 * keyed by what each gathers by and named from paths (`groupNames`), the groups with a running session first and then the most recently
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
  const homeOf = homesOf(sessions);
  const nameOf = groupNames(sessions, homeOf);
  const now = opts.now ?? Date.now();
  const keyOf = (s: SessionSummary) => {
    if (opts.groupBy === 'time') return `/${timeBucket(s.updatedAt, now)}`;
    const home = homeOf(s);
    return home ? projectKey(home.path) : `/n/${s.project}`;
  };
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
    const first = sorted[0] as SessionSummary;
    const home = homeOf(first)?.path ?? null;
    return {
      kind: 'project' as const,
      key,
      name: nameOf(first),
      cwd: sharedCwd(sorted) ?? home,
      worktrees: worktreesOf(sorted, home),
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
 * (the one at `root`, by default the first repository root a session names) first, then the
 * others as their first (running-first) session ranks them. A session without a repository
 * counts in the tree of its own directory: a removed worktree, gathered by `homesOf`. Null for
 * one tree, or when a session names no directory at all: nothing to split by.
 */
export function worktreesOf(
  sessions: readonly SessionSummary[],
  root: string | null = sessions.find((s) => s.repo)?.repo?.root ?? null,
): Worktree[] | null {
  const main = root === null ? null : segments(root).join('/');
  const trees = new Map<string, Worktree>();
  for (const s of sessions) {
    const dir = s.repo?.dir ?? s.cwd;
    if (!dir) return null;
    const gone = !s.repo && s.cwdGone === true;
    const key = segments(dir).join('/');
    const tree = trees.get(key);
    if (tree) {
      tree.sessions.push(s);
      tree.gone &&= gone;
    } else
      trees.set(key, {
        dir,
        name: segments(dir).at(-1) ?? s.repo?.name ?? s.project,
        main: key === main,
        gone,
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

/** What a project group gathers by: a repository's root or a directory, and its segments. */
export interface Home {
  path: string;
  segs: string[];
}

/** A project group's key: `/p/` and the directory's segments, whichever separator, joined. */
export const projectKey = (dir: string): string => `/p/${segments(dir).join('/')}`;

/**
 * What a session groups by on its own: its repository's root when the server read one (every
 * worktree of a repository gathers under it, wherever it is), else its own directory; null
 * without either (or for the filesystem's root, which names nothing).
 */
function identityOf(s: Named): Home | null {
  const path = s.repo?.root ?? s.cwd;
  if (!path) return null;
  const segs = segments(path);
  return segs.length > 0 ? { path, segs } : null;
}

/**
 * What each session's group gathers by (its `Home`): `identityOf`, except for a session the
 * server read no repository for (a worktree whose directory was removed, a server that does
 * not look), which joins a repository it can tell from paths:
 * - the one whose working tree is that very directory, as another session says;
 * - else the one its parent directory is named like (`…/work/glassbox/whitefish` and a session
 *   in repository `glassbox`, or in a directory `…/src/glassbox`), when the parent is not
 *   itself a session's directory (that is a subdirectory, `…/src/api/web`). Two repositories
 *   of that name: the one with a working tree beside it, else neither.
 * A repository that itself joined another hosts nothing: no chains. A session without a
 * directory joins the one home named as the server names its project, if there is one.
 */
export function homesOf(sessions: readonly Named[]): (s: Named) => Home | null {
  const own = new Map<string, Home>();
  // Each repository's working trees' parents, and each working tree's repository, by segments.
  const beside = new Map<string, Set<string>>();
  const treeOf = new Map<string, Home>();
  for (const s of sessions) {
    const home = identityOf(s);
    if (!home) continue;
    const canon = home.segs.join('/');
    own.set(canon, home);
    if (!s.repo) continue;
    const dir = segments(s.repo.dir);
    treeOf.set(dir.join('/'), home);
    const parents = beside.get(canon) ?? new Set<string>();
    parents.add(dir.slice(0, -1).join('/'));
    beside.set(canon, parents);
  }
  const byName = new Map<string, string[]>();
  for (const [canon, home] of own) {
    const name = home.segs.at(-1) as string;
    byName.set(name, [...(byName.get(name) ?? []), canon]);
  }
  const joined = new Map<string, Home>();
  for (const s of sessions) {
    if (s.repo || !s.cwd) continue;
    const segs = segments(s.cwd);
    const canon = segs.join('/');
    if (joined.has(canon)) continue;
    const tree = treeOf.get(canon);
    if (tree) {
      joined.set(canon, tree);
      continue;
    }
    const parent = segs.slice(0, -1).join('/');
    const parentName = segs.at(-2);
    if (parentName === undefined || own.has(parent)) continue;
    const named = (byName.get(parentName) ?? []).filter((c) => c !== canon);
    const near = named.filter((c) => beside.get(c)?.has(parent));
    const host =
      near.length === 1 ? near[0] : near.length === 0 && named.length === 1 ? named[0] : undefined;
    const home = host === undefined ? undefined : own.get(host);
    if (home) joined.set(canon, home);
  }
  const guests = new Set(joined.keys());
  for (const [canon, home] of joined)
    if (guests.has(home.segs.join('/')) && !treeOf.has(canon)) joined.delete(canon);
  return (s) => {
    if (s.repo) return identityOf(s);
    if (!s.cwd) {
      const named = byName.get(s.project) ?? [];
      return named.length === 1 ? (own.get(named[0] as string) ?? null) : null;
    }
    return joined.get(segments(s.cwd).join('/')) ?? identityOf(s);
  };
}

/**
 * The name each session's group (`homesOf`) reads as (no project file is read): the
 * repository's name when the server knows the repository or `homesOf` tells it, else its
 * directory's last segment, as the server names it, but with the parent directory's name before
 * it ("glassbox/weever") in two cases:
 * - a worktree the server could not tell and `homesOf` could not place: the parent is named
 *   like more than one other session's own directory or repository, without being one itself
 *   (`…/work/glassbox/weever` beside `/a/glassbox` and `/b/glassbox`). Worktrees whose
 *   repository has no session of its own keep their directory's name: from paths alone, a folder
 *   of worktrees and a folder of unrelated projects look the same;
 * - two directories (or repositories) that would read alike (`…/work/api` and `…/home/api`),
 *   which take as many parent segments as tell them apart.
 * A session without a directory keeps the server's name.
 */
export function groupNames(
  sessions: readonly Named[],
  homeOf: (s: Named) => Home | null = homesOf(sessions),
): (s: Named) => string {
  // Each distinct home once, by its segments joined: "/w/x" and "/w/x/" are one.
  const dirs = new Map<string, string[]>();
  for (const s of sessions) {
    const segs = homeOf(s)?.segs;
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
    const segs = homeOf(s)?.segs;
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
