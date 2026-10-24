/**
 * A session's time as segments: what each model request and tool call was doing when. Shared by
 * the Timeline (web) and the weekly receipt's hours (server), so both read time the same way.
 */
import type { ModelRequest, ToolCall } from '../core/model.js';
import type { ToolCategory } from './tool-category.js';

/** 'approval': a tool blocked on the person answering a permission prompt. */
export type SegmentKind = 'waiting' | 'thinking' | 'generating' | 'tool' | 'approval';

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

/** Epoch ms, or null for a missing or malformed time (never NaN, which would poison the chart). */
export const ms = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * A request's time: queued (sent, before thinking began), thinking, then generating. An
 * in-flight call is all thinking: nothing is on disk until its first block completes.
 */
export function requestSegments(r: ModelRequest, now: number): Segment[] {
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
 * A tool call's start and end: a running one ends now. `preferDuration` ends a finished tool at
 * start + recorded duration when the end time is coarser than the duration (totals use it; the
 * lanes draw what the log says). Null without a start time.
 */
export function toolSpan(
  t: ToolCall,
  now: number,
  preferDuration = false,
): [number, number] | null {
  const start = ms(t.startedAt);
  if (start === null) return null;
  const recorded = t.durationMs !== null ? start + t.durationMs : null;
  const end = Math.max(
    start,
    t.status === 'running'
      ? now
      : ((preferDuration ? recorded : null) ?? ms(t.endedAt) ?? recorded ?? start),
  );
  return [start, end];
}
