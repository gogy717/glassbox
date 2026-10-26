/**
 * A session as sparse hourly buckets, and a window as a slice of them (the weekly receipt).
 *
 * Pure: no I/O. Every figure is the one the session's own receipt prints (the Summary bar's
 * `summarize`, for the main agent and for each sub-agent, the Tokens tab's totals), only split by
 * hour, so the buckets of a session add up to its receipt. Hours are local: a bucket is keyed by
 * the instant its local hour starts.
 */
import type { SessionSnapshot, TokenUsage } from '../core/model.js';
import { MAIN_AGENT_ID } from '../core/model.js';
import { addUsage, emptyUsage } from '../core/usage.js';
import { ms, toolSpan } from '../shared/segments.js';
import { type ToolCategory, toolCategory } from '../shared/tool-category.js';
import {
  HOUR_MS,
  hourStart,
  nextHour,
  type WeekFigures,
  type WeekSession,
  type WeekWindow,
} from '../shared/week.js';

export { HOUR_MS, hourStart, weekStart, weekWindow } from '../shared/week.js';

export interface HourBucket {
  activeMs: number;
  agentMs: number;
  requests: number;
  toolCalls: number;
  toolCats: Partial<Record<ToolCategory, number>>;
  failures: number;
  usage: TokenUsage;
  /** `usage` by model, as `WeekFigures.usageByModel`. */
  usageByModel: Record<string, TokenUsage>;
}

/** Adds `u` to what `byModel` holds for `model`. */
function addByModel(byModel: Record<string, TokenUsage>, model: string, u: TokenUsage): void {
  const held = byModel[model];
  if (held) addUsage(held, u);
  else byModel[model] = addUsage(emptyUsage(), u);
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
  /** Whether any of its calls reported usage (the receipt's `measured`, for the whole session). */
  reportsUsage: boolean;
}

const emptyBucket = (): HourBucket => ({
  activeMs: 0,
  agentMs: 0,
  requests: 0,
  toolCalls: 0,
  toolCats: {},
  failures: 0,
  usage: emptyUsage(),
  usageByModel: {},
});

/** Entities handled between two pauses when a session is bucketed with pauses. */
const STEP = 2_000;

/**
 * The session's buckets as of `now`: running turns and calls end there, and no time is counted
 * after it (a turn that ended while the session was being read is cut there). Yields every
 * `STEP` entities so a caller can pause between them. The parity with its receipt (web
 * `receiptData`) is tested on the web side.
 */
function* bucketing(snap: SessionSnapshot, now: number): Generator<void, SessionBuckets> {
  let n = 0;
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

  // Each agent's first and last moment at work: a sub-agent's life when its own are unknown.
  const seen = new Map<string, [number, number]>();
  const saw = (agentId: string, a: number, b: number) => {
    const was = seen.get(agentId);
    seen.set(agentId, was ? [Math.min(was[0], a), Math.max(was[1], b)] : [a, b]);
  };

  // Agent time: every agent's own turns, a running one up to now (each agent's Summary bar active
  // time); the main agent's are the session's active time too.
  for (const t of snap.turns) {
    if (++n % STEP === 0) yield;
    if (!ids.has(t.agentId)) continue;
    const start = ms(t.startedAt);
    const ended = t.endedAt ? ms(t.endedAt) : t.status === 'running' ? now : null;
    if (start === null || ended === null) continue;
    const end = Math.min(ended, now);
    saw(t.agentId, start, Math.max(start, end));
    const main = t.agentId === MAIN_AGENT_ID;
    spread(start, end, (b, part) => {
      b.agentMs += part;
      if (main) b.activeMs += part;
    });
  }

  // When a request or tool call without a start time happened: its turn's, else the session's.
  const fallback = ms(snap.session.startedAt) ?? ms(snap.session.updatedAt) ?? now;
  const turnStart = new Map(snap.turns.map((t) => [t.id, ms(t.startedAt)]));
  const requestStart = new Map<string, number>();
  let reportsUsage = false;
  for (const r of snap.requests) {
    if (++n % STEP === 0) yield;
    const start = ms(r.startedAt) ?? (r.turnId ? turnStart.get(r.turnId) : null) ?? fallback;
    requestStart.set(r.id, start);
    saw(r.agentId, start, ms(r.endedAt) ?? (r.status === 'in-flight' ? now : start));
    const b = at(start);
    if (r.status === 'error') b.failures++;
    if (!ids.has(r.agentId)) continue;
    b.requests++;
    if (r.usage) {
      addUsage(b.usage, r.usage);
      addByModel(b.usageByModel, r.model ?? '', r.usage);
      reportsUsage = true;
    }
  }
  for (const t of snap.toolCalls) {
    if (++n % STEP === 0) yield;
    const b = at(ms(t.startedAt) ?? requestStart.get(t.requestId) ?? fallback);
    const span = toolSpan(t, now);
    if (span) saw(t.agentId, span[0], span[1]);
    if (t.status === 'error') b.failures++;
    const cat = toolCategory(t.name, t.input);
    b.toolCats[cat] = (b.toolCats[cat] ?? 0) + 1;
    if (ids.has(t.agentId)) b.toolCalls++;
  }

  // Sub-agents' lives: from their start to their end, else to their first and last activity.
  const subAgents: [number, number][] = [];
  for (const a of snap.agents) {
    if (a.id === MAIN_AGENT_ID) continue;
    const start = ms(a.startedAt) ?? seen.get(a.id)?.[0];
    if (start === undefined) continue;
    const end = ms(a.endedAt) ?? (a.status === 'running' ? now : (seen.get(a.id)?.[1] ?? start));
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
    reportsUsage,
  };
}

/** The session's buckets: see `bucketing`. */
export function sessionBuckets(snap: SessionSnapshot, now: number): SessionBuckets {
  const steps = bucketing(snap, now);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * The same, awaiting `pause()` every few thousand entities: a session of hundreds of megabytes
 * is bucketed without holding the event loop.
 */
export async function sessionBucketsPausing(
  snap: SessionSnapshot,
  now: number,
  pause: () => Promise<void>,
): Promise<SessionBuckets> {
  const steps = bucketing(snap, now);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await pause();
  }
}

/**
 * The window hour a bucket starting at `t` goes to: the last starting at or before it (an hour
 * long at most), or -1 outside the window. A bucket starts on a local hour, as the window's hours
 * mostly do; where they part (the last 7 days are hours of the clock, which Lord Howe's half-hour
 * change of the clocks moves off its local hours), it goes to the hour it starts in, and one that
 * starts before the window but runs into its first hour goes to that hour.
 */
function slotOf(hourStarts: number[], t: number): number {
  let lo = 0;
  let hi = hourStarts.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((hourStarts[mid] as number) <= t) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (at < 0) {
    const first = hourStarts[0];
    return first !== undefined && t > first - HOUR_MS ? 0 : -1;
  }
  const end = hourStarts[at + 1] ?? (hourStarts[at] as number) + HOUR_MS;
  return t < end ? at : -1;
}

/**
 * What a session did in the given hours (a window's, or any run of hours), `tags` as it is
 * listed; null if nothing.
 */
export function sliceSession(
  b: SessionBuckets,
  window: WeekWindow,
  tags: string[] = [],
): WeekSession | null {
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
    usageByModel: {},
  };
  for (const [h, bucket] of b.hours) {
    const i = slotOf(window.hourStarts, h);
    if (i < 0) continue;
    // Two buckets can share an hour of the window where local hours part from it: add, not set.
    hours[i] = (hours[i] ?? 0) + bucket.agentMs;
    f.activeMs += bucket.activeMs;
    f.agentMs += bucket.agentMs;
    f.requests += bucket.requests;
    f.toolCalls += bucket.toolCalls;
    for (const [cat, n] of Object.entries(bucket.toolCats) as [ToolCategory, number][])
      f.toolCats[cat] = (f.toolCats[cat] ?? 0) + n;
    f.failures += bucket.failures;
    addUsage(f.usage, bucket.usage);
    for (const [model, u] of Object.entries(bucket.usageByModel))
      addByModel(f.usageByModel, model, u);
  }
  const first = window.hourStarts[0];
  const last = window.hourStarts.at(-1);
  if (first !== undefined && last !== undefined) {
    const end = last + HOUR_MS;
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
    tags,
    reportsUsage: b.reportsUsage,
    inWindow: f,
    hours,
  };
}
