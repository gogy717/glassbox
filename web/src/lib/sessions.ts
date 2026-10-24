import type { AgentKind, SessionSummary } from '../../../src/core/model.js';

export interface SessionGroup {
  project: string;
  sessions: SessionSummary[];
}

/** A session blocked on the user's confirmation needs attention as much as a running one. */
const active = (s: SessionSummary) => Number(s.live === 'busy' || s.live === 'waiting');

const busyFirst = (a: SessionSummary, b: SessionSummary) =>
  active(b) - active(a) || b.updatedAt.localeCompare(a.updatedAt);

/** The sidebar's live-state filter. Running holds busy and waiting: both need someone now. */
export type LiveFilter = 'running' | 'idle' | 'closed';

export const LIVE_FILTERS: readonly LiveFilter[] = ['running', 'idle', 'closed'];

/** Which live-state filter a session falls under; an unknown state counts as closed. */
export function liveFilterOf(s: SessionSummary): LiveFilter {
  if (s.live === 'busy' || s.live === 'waiting') return 'running';
  return s.live === 'idle' ? 'idle' : 'closed';
}

/** Background probe sessions (e.g. ClaudeBar's) are noise unless asked for. */
export const isListed = (s: SessionSummary, showProbes = false): boolean =>
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
