/**
 * A session as sparse hourly buckets, and a window as a slice of them (the weekly receipt).
 *
 * Pure: no I/O. Every figure is the one the session's own receipt prints (the Summary bar's
 * `summarize`, the Timeline's segments, the Tokens tab's totals), only split by hour, so the
 * buckets of a session add up to its receipt. Hours are local: a bucket is keyed by the instant
 * its local hour starts.
 */
import type { SessionSnapshot, TokenUsage } from '../core/model.js';
import { MAIN_AGENT_ID } from '../core/model.js';
import { addUsage, emptyUsage } from '../core/usage.js';
import { ms, requestSegments, toolSpan } from '../shared/segments.js';
import { type ToolCategory, toolCategory } from '../shared/tool-category.js';
import type { WeekFigures, WeekSession, WeekWindow, WeekWindowKind } from '../shared/week.js';

export const HOUR_MS = 3_600_000;

/** Start of the local hour that holds `t`. */
export function hourStart(t: number): number {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/** Start of the local hour after the one starting at `h` (an hour later on any clock). */
const nextHour = (h: number) => {
  const next = hourStart(h + HOUR_MS);
  return next > h ? next : h + HOUR_MS;
};

/** Local Monday 00:00 of the week holding `t`. */
export function weekStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** The hours of a window: see `WeekWindow`. */
export function weekWindow(kind: WeekWindowKind, now: number): WeekWindow {
  let start: number;
  let end: number;
  if (kind === 'week') {
    start = weekStart(now);
    const next = new Date(start);
    next.setDate(next.getDate() + 7);
    end = next.getTime();
  } else {
    end = nextHour(hourStart(now));
    start = hourStart(now) - 168 * HOUR_MS;
  }
  const hourStarts: number[] = [];
  for (let h = start; h < end; h = nextHour(h)) hourStarts.push(h);
  return { kind, hourStarts, now };
}

export interface HourBucket {
  activeMs: number;
  agentMs: number;
  requests: number;
  toolCalls: number;
  toolCats: Partial<Record<ToolCategory, number>>;
  failures: number;
  usage: TokenUsage;
  measured: boolean;
}

/** A session's buckets: what its receipt says, by hour. */
export interface SessionBuckets {
  id: string;
  /** The session's `updatedAt` when it was read: the key the buckets are good for. */
  updatedAt: string;
  agent: WeekSession['agent'];
  project: string;
  cwd: string | null;
  title: string | null;
  /** By the start of their local hour; only hours with something in them. */
  hours: Map<number, HourBucket>;
  /** Each sub-agent's life, [start, end]: counted in a window it overlaps. */
  subAgents: [number, number][];
}

const emptyBucket = (): HourBucket => ({
  activeMs: 0,
  agentMs: 0,
  requests: 0,
  toolCalls: 0,
  toolCats: {},
  failures: 0,
  usage: emptyUsage(),
  measured: false,
});

/** Merges overlapping intervals, sorted by start. */
function union(intervals: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...intervals].sort((p, q) => p[0] - q[0])) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * The session's buckets, read from a snapshot taken at `now` (running turns and calls end
 * there). The parity with its receipt (web `receiptData`) is tested on the web side.
 */
export function sessionBuckets(snap: SessionSnapshot, now: number): SessionBuckets {
  const hours = new Map<number, HourBucket>();
  const at = (t: number) => {
    const h = hourStart(t);
    let b = hours.get(h);
    if (!b) {
      b = emptyBucket();
      hours.set(h, b);
    }
    return b;
  };
  /** Adds the length of [a, b) to each hour it overlaps. */
  const spread = (a: number, b: number, add: (bucket: HourBucket, ms: number) => void) => {
    for (let h = hourStart(a); h < b; h = nextHour(h)) {
      const part = Math.min(b, nextHour(h)) - Math.max(a, h);
      if (part > 0) add(at(h), part);
    }
  };

  // The main agent and its descendants, as the Summary bar counts them.
  const ids = new Set([MAIN_AGENT_ID]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of snap.agents)
      if (a.parentId !== null && ids.has(a.parentId) && !ids.has(a.id)) {
        ids.add(a.id);
        grew = true;
      }
  }

  // Active time: the main agent's turns, a running one up to now.
  for (const t of snap.turns) {
    if (t.agentId !== MAIN_AGENT_ID) continue;
    const start = ms(t.startedAt);
    const end = t.endedAt ? ms(t.endedAt) : t.status === 'running' ? now : null;
    if (start !== null && end !== null) spread(start, end, (b, part) => (b.activeMs += part));
  }

  // When a request or tool call without a start time happened: its turn's, else the session's.
  const fallback = ms(snap.session.startedAt) ?? ms(snap.session.updatedAt) ?? now;
  const turnStart = new Map(snap.turns.map((t) => [t.id, ms(t.startedAt)]));
  const requestStart = new Map<string, number>();
  for (const r of snap.requests) {
    const start = ms(r.startedAt) ?? (r.turnId ? turnStart.get(r.turnId) : null) ?? fallback;
    requestStart.set(r.id, start);
    const b = at(start);
    if (r.status === 'error') b.failures++;
    if (!ids.has(r.agentId)) continue;
    b.requests++;
    if (r.usage) {
      addUsage(b.usage, r.usage);
      b.measured = true;
    }
  }
  for (const t of snap.toolCalls) {
    const b = at(ms(t.startedAt) ?? requestStart.get(t.requestId) ?? fallback);
    if (t.status === 'error') b.failures++;
    const cat = toolCategory(t.name, t.input);
    b.toolCats[cat] = (b.toolCats[cat] ?? 0) + 1;
    if (ids.has(t.agentId)) b.toolCalls++;
  }

  // Agent time: each agent's work (not its queueing), its overlaps counted once; the agents the
  // calls are counted for, as the Timeline draws them.
  const work = new Map<string, [number, number][]>();
  const push = (agentId: string, a: number, b: number) => {
    if (b <= a || !ids.has(agentId)) return;
    const list = work.get(agentId);
    if (list) list.push([a, b]);
    else work.set(agentId, [[a, b]]);
  };
  for (const r of snap.requests)
    for (const s of requestSegments(r, now))
      if (s.kind !== 'waiting') push(r.agentId, s.start, s.end);
  for (const t of snap.toolCalls) {
    const span = toolSpan(t, now);
    if (span) push(t.agentId, span[0], span[1]);
  }
  for (const list of work.values())
    for (const [a, b] of union(list)) spread(a, b, (bucket, part) => (bucket.agentMs += part));

  // Sub-agents' lives: from their start to their end, or to their last activity.
  const lastActivity = new Map<string, number>();
  for (const [agentId, list] of work)
    lastActivity.set(agentId, Math.max(...list.map(([, b]) => b)));
  const subAgents: [number, number][] = [];
  for (const a of snap.agents) {
    if (a.id === MAIN_AGENT_ID) continue;
    const start = ms(a.startedAt) ?? work.get(a.id)?.reduce((m, [s]) => Math.min(m, s), Infinity);
    if (start === undefined || !Number.isFinite(start)) continue;
    const end = ms(a.endedAt) ?? (a.status === 'running' ? now : (lastActivity.get(a.id) ?? start));
    subAgents.push([start, Math.max(start, end)]);
  }

  const s = snap.session;
  return {
    id: s.id,
    updatedAt: s.updatedAt,
    agent: s.agent,
    project: s.project,
    cwd: s.cwd,
    title: s.title,
    hours,
    subAgents,
  };
}

/** What a session did in the given hours (a window's, or any run of hours); null if nothing. */
export function sliceSession(b: SessionBuckets, window: WeekWindow): WeekSession | null {
  const index = new Map(window.hourStarts.map((h, i) => [h, i]));
  const hours = window.hourStarts.map(() => 0);
  const f: WeekFigures = {
    activeMs: 0,
    agentMs: 0,
    requests: 0,
    toolCalls: 0,
    toolCats: {},
    subAgents: 0,
    failures: 0,
    usage: emptyUsage(),
    measured: false,
  };
  for (const [h, bucket] of b.hours) {
    const i = index.get(h);
    if (i === undefined) continue;
    hours[i] = bucket.agentMs;
    f.activeMs += bucket.activeMs;
    f.agentMs += bucket.agentMs;
    f.requests += bucket.requests;
    f.toolCalls += bucket.toolCalls;
    for (const [cat, n] of Object.entries(bucket.toolCats) as [ToolCategory, number][])
      f.toolCats[cat] = (f.toolCats[cat] ?? 0) + n;
    f.failures += bucket.failures;
    addUsage(f.usage, bucket.usage);
    f.measured ||= bucket.measured;
  }
  const first = window.hourStarts[0];
  const last = window.hourStarts.at(-1);
  if (first !== undefined && last !== undefined) {
    const end = nextHour(last);
    f.subAgents = b.subAgents.filter(([a, z]) => a < end && z >= first).length;
  }
  const any =
    f.activeMs > 0 ||
    f.agentMs > 0 ||
    f.requests > 0 ||
    f.toolCalls > 0 ||
    f.failures > 0 ||
    f.subAgents > 0;
  if (!any) return null;
  return {
    id: b.id,
    agent: b.agent,
    project: b.project,
    cwd: b.cwd,
    title: b.title,
    inWindow: f,
    hours,
  };
}
