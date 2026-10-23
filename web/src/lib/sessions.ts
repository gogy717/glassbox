import type { SessionSummary } from '../../../src/core/model.js';

export interface SessionGroup {
  project: string;
  sessions: SessionSummary[];
}

/** A session blocked on the user's confirmation needs attention as much as a running one. */
const active = (s: SessionSummary) => Number(s.live === 'busy' || s.live === 'waiting');

const busyFirst = (a: SessionSummary, b: SessionSummary) =>
  active(b) - active(a) || b.updatedAt.localeCompare(a.updatedAt);

/**
 * Sidebar grouping: by project, running sessions first (in groups and within them), then most
 * recently updated. `query` matches title or cwd, case-insensitively.
 */
/** Background probe sessions (e.g. ClaudeBar's) are noise unless asked for. */
export const isListed = (s: SessionSummary, showProbes = false): boolean =>
  showProbes || !s.tags?.includes('probe');

export function groupSessions(
  sessions: SessionSummary[],
  query: string,
  opts: { showProbes?: boolean } = {},
): SessionGroup[] {
  const q = query.trim().toLowerCase();
  const matches = (s: SessionSummary) =>
    isListed(s, opts.showProbes) &&
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
