/** Where the time went: swimlane segments per agent, totals, and the slowest steps. */
import type { ModelRequest, ToolCall } from '../../../src/core/model.js';
import type { Approvals } from '../data/approvals';
import type { OpenSession } from '../data/store';
import { agentTree } from './agents';
import { type ToolCategory, toolCategory } from './tool-category';

/** 'approval': a tool blocked on the person answering a permission prompt. */
export type SegmentKind = 'waiting' | 'thinking' | 'generating' | 'tool' | 'approval';

/** Segments that stand for a tool call rather than part of a model request. */
const isToolSeg = (s: Segment) => s.kind === 'tool' || s.kind === 'approval';

export interface Segment {
  kind: SegmentKind;
  start: number;
  end: number;
  /** The request id, or the tool call id for tool segments. */
  refId: string;
  requestId: string;
  category?: ToolCategory;
  /** Still running: `end` is the current time. */
  live?: boolean;
}

export interface Lane {
  agentId: string;
  label: string;
  /** "workflow · phase" for workflow agents. */
  group: string | null;
  segments: Segment[];
}

/** Epoch ms, or null for a missing or malformed time (never NaN, which would poison the chart). */
const ms = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

function requestSegments(r: ModelRequest, now: number): Segment[] {
  const start = ms(r.startedAt);
  if (start === null) return [];
  const base = { refId: r.id, requestId: r.id };
  if (r.status === 'in-flight') {
    // Nothing is on disk until the first block completes, so we cannot tell queueing from
    // thinking; at max effort it is almost always thinking.
    return [{ kind: 'thinking', start, end: Math.max(start, now), live: true, ...base }];
  }
  const first = ms(r.firstBlockAt);
  const end = ms(r.endedAt) ?? first ?? start;
  if (first === null) return end > start ? [{ kind: 'generating', start, end, ...base }] : [];
  const thinkingMs = r.blocks.reduce(
    (sum, b) => sum + (b.kind === 'thinking' ? (b.durationMs ?? 0) : 0),
    0,
  );
  const thinkStart = Math.max(start, first - thinkingMs);
  const out: Segment[] = [
    { kind: 'waiting', start, end: thinkStart, ...base },
    { kind: 'thinking', start: thinkStart, end: first, ...base },
    { kind: 'generating', start: first, end: Math.max(first, end), ...base },
  ];
  return out.filter((s) => s.end > s.start);
}

/**
 * A tool call's time. The part spent blocked on a permission prompt (still open, or answered)
 * is its own 'approval' segment: the tool was not running then, the person was being asked.
 * `preferDuration` ends a finished tool at start + recorded duration when the end time is
 * coarser than the duration (totals use it; the lanes draw what the log says).
 */
function toolSegments(
  t: ToolCall,
  now: number,
  approvals?: Approvals,
  preferDuration = false,
): Segment[] {
  const start = ms(t.startedAt);
  if (start === null) return [];
  const live = t.status === 'running';
  const recorded = t.durationMs !== null ? start + t.durationMs : null;
  const end = Math.max(
    start,
    live ? now : ((preferDuration ? recorded : null) ?? ms(t.endedAt) ?? recorded ?? start),
  );
  const base = { refId: t.id, requestId: t.requestId, category: toolCategory(t.name, t.input) };
  const tool = (from: number, to: number, isLive: boolean): Segment => ({
    kind: 'tool',
    start: from,
    end: to,
    ...base,
    ...(isLive ? { live: true } : {}),
  });

  const wait = approvals?.get(t.id);
  // An open prompt only blocks a tool that is still running.
  const waitEnd = wait ? (wait.decidedAt ?? (live ? end : null)) : null;
  if (!wait || waitEnd === null) return [tool(start, end, live)];
  const from = Math.max(start, wait.requestedAt);
  const to = Math.min(end, waitEnd);
  if (to <= from) return [tool(start, end, live)];
  const blockedNow = live && wait.decidedAt === null;
  const out: Segment[] = [
    tool(start, from, false),
    { kind: 'approval', start: from, end: to, ...base, ...(blockedNow ? { live: true } : {}) },
    tool(to, end, live && !blockedNow),
  ];
  return out.filter((s) => s.end > s.start);
}

export function timeSegments(open: OpenSession, now: number, approvals?: Approvals): Lane[] {
  const byAgent = new Map<string, Segment[]>();
  const push = (agentId: string, segs: Segment[]) => {
    const list = byAgent.get(agentId);
    if (list) list.push(...segs);
    else byAgent.set(agentId, [...segs]);
  };
  for (const r of open.requests.values()) push(r.agentId, requestSegments(r, now));
  for (const t of open.toolCalls.values()) {
    push(t.agentId, toolSegments(t, now, approvals));
  }
  const lanes: Lane[] = [];
  for (const row of agentTree(open)) {
    if (row.kind !== 'agent') continue;
    const a = row.agent;
    const wf = a.workflowRunId ? open.workflows.get(a.workflowRunId) : undefined;
    const group = wf ? [wf.name ?? wf.id, a.phase].filter(Boolean).join(' · ') : null;
    lanes.push({
      agentId: a.id,
      label: a.label,
      group,
      segments: (byAgent.get(a.id) ?? []).sort((x, y) => x.start - y.start),
    });
  }
  return lanes;
}

export interface TimeBreakdown {
  model: { waiting: number; thinking: number; generating: number };
  /** Wall-clock time per category: parallel tools of one kind count once. */
  tools: Partial<Record<ToolCategory, number>>;
  /** Gaps between the agent's turns, e.g. waiting for the person to reply. */
  idle: number;
  /** Tools blocked on a permission prompt: also time spent waiting for the person. */
  approval: number;
}

export function timeBreakdown(
  open: OpenSession,
  agentId: string,
  now: number,
  approvals?: Approvals,
): TimeBreakdown {
  const out: TimeBreakdown = {
    model: { waiting: 0, thinking: 0, generating: 0 },
    tools: {},
    idle: 0,
    approval: 0,
  };
  for (const r of open.requests.values()) {
    if (r.agentId !== agentId) continue;
    for (const s of requestSegments(r, now)) {
      if (!isToolSeg(s)) out.model[s.kind as keyof TimeBreakdown['model']] += s.end - s.start;
    }
  }
  const byCategory = new Map<ToolCategory, Segment[]>();
  const blocked: Segment[] = [];
  for (const t of open.toolCalls.values()) {
    if (t.agentId !== agentId) continue;
    for (const s of toolSegments(t, now, approvals, true)) {
      if (s.kind === 'approval') blocked.push(s);
      else if (s.category) {
        const list = byCategory.get(s.category);
        if (list) list.push(s);
        else byCategory.set(s.category, [s]);
      }
    }
  }
  for (const [category, segs] of byCategory) out.tools[category] = activeMs(segs);
  out.approval = activeMs(blocked);
  const turns = [...open.turns.values()]
    .filter((t) => t.agentId === agentId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (let i = 1; i < turns.length; i++) {
    const prevEnd = ms(turns[i - 1]?.endedAt);
    const start = ms(turns[i]?.startedAt);
    if (prevEnd !== null && start !== null && start > prevEnd) out.idle += start - prevEnd;
  }
  return out;
}

export interface SlowItem {
  kind: 'request' | 'tool';
  id: string;
  requestId: string;
  agentId: string;
  /** Tool name for tools; model for requests. */
  name: string | null;
  durationMs: number;
  live: boolean;
}

/** The longest requests and tool calls; running ones count up to `now`. */
export function slowest(
  open: OpenSession,
  agentIds: Set<string> | null,
  now: number,
  n: number,
): SlowItem[] {
  const items: SlowItem[] = [];
  const keep = (agentId: string) => !agentIds || agentIds.has(agentId);
  for (const r of open.requests.values()) {
    const start = ms(r.startedAt);
    if (!keep(r.agentId) || start === null) continue;
    const live = r.status === 'in-flight';
    const end = live ? now : ms(r.endedAt);
    if (end === null) continue;
    items.push({
      kind: 'request',
      id: r.id,
      requestId: r.id,
      agentId: r.agentId,
      name: r.model,
      durationMs: end - start,
      live,
    });
  }
  for (const t of open.toolCalls.values()) {
    if (!keep(t.agentId)) continue;
    // Without approval windows a tool is one segment: its whole span.
    const [s] = toolSegments(t, now);
    if (!s) continue;
    items.push({
      kind: 'tool',
      id: t.id,
      requestId: t.requestId,
      agentId: t.agentId,
      name: t.name,
      durationMs: s.end - s.start,
      live: !!s.live,
    });
  }
  return items.sort((a, b) => b.durationMs - a.durationMs).slice(0, n);
}

export interface TimeScale {
  x(t: number): number;
  /** Time at an x position (inverse of `x`, used for hover and zoom anchoring). */
  t(x: number): number;
  width: number;
  breaks: { x0: number; x1: number; from: number; to: number }[];
  start: number;
  end: number;
}

interface ScaleOptions {
  pxPerMs: number;
  /** Idle gaps longer than this collapse into a fixed-width break. */
  gapMs: number;
  breakPx: number;
}

/**
 * Piecewise-linear time axis: active stretches are drawn to scale, long idle gaps (a person away
 * for an hour) shrink to `breakPx` so the chart is not mostly empty.
 */
export function buildTimeScale(intervals: [number, number][], o: ScaleOptions): TimeScale {
  const sorted = intervals
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number])
    .sort((p, q) => p[0] - q[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = merged.at(-1);
    if (last && a - last[1] <= o.gapMs) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  if (merged.length === 0)
    return { x: () => 0, t: () => 0, width: 0, breaks: [], start: 0, end: 0 };

  // Each piece maps [t0, t1] onto [x0, x1]; breaks are pieces with a fixed width.
  const pieces: { t0: number; t1: number; x0: number; x1: number }[] = [];
  const breaks: TimeScale['breaks'] = [];
  let x = 0;
  merged.forEach(([a, b], i) => {
    if (i > 0) {
      const prevEnd = (merged[i - 1] as [number, number])[1];
      pieces.push({ t0: prevEnd, t1: a, x0: x, x1: x + o.breakPx });
      breaks.push({ x0: x, x1: x + o.breakPx, from: prevEnd, to: a });
      x += o.breakPx;
    }
    const w = (b - a) * o.pxPerMs;
    pieces.push({ t0: a, t1: b, x0: x, x1: x + w });
    x += w;
  });
  const first = pieces[0] as (typeof pieces)[number];
  const last = pieces.at(-1) as (typeof pieces)[number];
  const lerp = (v: number, a0: number, a1: number, b0: number, b1: number) =>
    a1 === a0 ? b0 : b0 + ((v - a0) / (a1 - a0)) * (b1 - b0);
  return {
    x(t) {
      if (t <= first.t0) return first.x0;
      if (t >= last.t1) return last.x1;
      const p = pieces.find((q) => t <= q.t1) ?? last;
      return lerp(t, p.t0, p.t1, p.x0, p.x1);
    },
    t(px) {
      if (px <= first.x0) return first.t0;
      if (px >= last.x1) return last.t1;
      const p = pieces.find((q) => px <= q.x1) ?? last;
      return lerp(px, p.x0, p.x1, p.t0, p.t1);
    },
    width: x,
    breaks,
    start: first.t0,
    end: last.t1,
  };
}

/** Union length of the segments' intervals: how long the agent was doing anything. */
export function activeMs(segments: Segment[]): number {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = Number.NaN;
  let curEnd = Number.NaN;
  for (const s of sorted) {
    if (Number.isNaN(curEnd) || s.start > curEnd) {
      if (!Number.isNaN(curEnd)) total += curEnd - curStart;
      curStart = s.start;
      curEnd = s.end;
    } else curEnd = Math.max(curEnd, s.end);
  }
  if (!Number.isNaN(curEnd)) total += curEnd - curStart;
  return total;
}

export interface DisplaySeg {
  x0: number;
  x1: number;
  start: number;
  end: number;
  /** Colour: the kind that took the most time; for tools also their category. */
  kind: SegmentKind;
  category?: ToolCategory;
  merged: boolean;
  /** Distinct requests and tool calls inside the block. */
  requests: number;
  tools: number;
  /** Summed durations of the members. */
  busyMs: number;
  /** The longest member's request: where a click leads. */
  requestId: string;
  refId: string;
  live: boolean;
}

/** A segment narrower than this is merged with its tiny neighbours. */
const VISIBLE_PX = 3;
const GAP_PX = 2;
const MIN_PX = 1.5;

/**
 * Level of detail for one lane at the current zoom. Long sessions put tens of seconds into a
 * pixel, so short requests would vanish and a busy agent would look idle. Runs of sub-pixel
 * segments less than 2 px apart become one block (coloured by what took the most time); anything
 * wide enough to see stays as it is. Re-run whenever the scale changes.
 */
export function mergeForDisplay(segments: Segment[], x: (t: number) => number): DisplaySeg[] {
  const out: DisplaySeg[] = [];
  let run: Segment[] = [];
  let runX1 = 0;

  const single = (s: Segment): DisplaySeg => {
    const x0 = x(s.start);
    return {
      x0,
      x1: Math.max(x(s.end), x0 + MIN_PX),
      start: s.start,
      end: s.end,
      kind: s.kind,
      ...(s.category ? { category: s.category } : {}),
      merged: false,
      requests: isToolSeg(s) ? 0 : 1,
      tools: isToolSeg(s) ? 1 : 0,
      busyMs: s.end - s.start,
      requestId: s.requestId,
      refId: s.refId,
      live: !!s.live,
    };
  };

  const flush = () => {
    if (run.length === 1) out.push(single(run[0] as Segment));
    else if (run.length > 1) {
      const byKey = new Map<string, number>();
      const requests = new Set<string>();
      let tools = 0;
      let longest = run[0] as Segment;
      for (const s of run) {
        const d = s.end - s.start;
        const key = s.kind === 'tool' ? `tool:${s.category ?? 'other'}` : s.kind;
        byKey.set(key, (byKey.get(key) ?? 0) + d);
        if (isToolSeg(s)) tools++;
        else requests.add(s.requestId);
        if (d > longest.end - longest.start) longest = s;
      }
      const [topKey] = [...byKey].reduce((a, b) => (b[1] > a[1] ? b : a));
      const [kind, category] = topKey.split(':') as [SegmentKind, ToolCategory | undefined];
      const start = Math.min(...run.map((s) => s.start));
      const end = Math.max(...run.map((s) => s.end));
      const x0 = x(start);
      out.push({
        x0,
        x1: Math.max(x(end), x0 + MIN_PX),
        start,
        end,
        kind,
        ...(category ? { category } : {}),
        merged: true,
        requests: requests.size,
        tools,
        busyMs: run.reduce((sum, s) => sum + (s.end - s.start), 0),
        requestId: longest.requestId,
        refId: longest.refId,
        live: run.some((s) => s.live),
      });
    }
    run = [];
  };

  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    const x0 = x(s.start);
    const x1 = x(s.end);
    if (x1 - x0 >= VISIBLE_PX) {
      flush();
      out.push(single(s));
      continue;
    }
    if (run.length && x0 - runX1 >= GAP_PX) flush();
    run.push(s);
    runX1 = run.length === 1 ? x1 : Math.max(runX1, x1);
  }
  flush();
  return out;
}

/** Width of one collapsed idle break: together they take about a fifth of the view. */
export function breakWidth(viewWidth: number, breaks: number): number {
  if (breaks <= 0) return 64;
  return Math.max(10, Math.min(64, Math.floor((viewWidth * 0.2) / breaks)));
}
