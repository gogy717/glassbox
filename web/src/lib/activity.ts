import type { OpenSession } from '../data/store';
import { subtreeIds } from './agents';

/** A mark on the strip: where along the agent's span, 0 at its start and 1 at its end. */
export interface StripMark {
  x: number;
}

/** A model call: its place, its output against the largest call's (0..1), hollow before usage. */
export interface StripCall extends StripMark {
  h: number;
  hollow: boolean;
}

/** What the summary bar's activity strip draws, for the agent shown and its sub-agents. */
export interface ActivityStrip {
  /** The agent's turns, first start to last end (now while running); null before any turn. */
  span: { start: number; end: number } | null;
  turns: StripMark[];
  calls: StripCall[];
  tools: StripMark[];
}

/**
 * The agent's span and what happened along it, by start time: each of the agent's turns, and
 * each model call and tool call of the agent and its sub-agents. A call without a start time is
 * left out. A span of no length puts everything at 0. Calls and tools come in start order.
 */
export function activityStrip(open: OpenSession, agentId: string, now: number): ActivityStrip {
  const ids = subtreeIds(open, agentId);
  let span: ActivityStrip['span'] = null;
  const turnStarts: number[] = [];
  for (const t of open.turns.values()) {
    if (t.agentId !== agentId) continue;
    const start = Date.parse(t.startedAt);
    if (!Number.isFinite(start)) continue;
    const end = t.endedAt ? Date.parse(t.endedAt) : t.status === 'running' ? now : start;
    const last = Math.max(start, Number.isFinite(end) ? end : start);
    span = span
      ? { start: Math.min(span.start, start), end: Math.max(span.end, last) }
      : { start, end: last };
    turnStarts.push(start);
  }
  const at = (iso: string | null): number | null => {
    if (!iso || !span) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    const length = span.end - span.start;
    return length > 0 ? Math.min(1, Math.max(0, (t - span.start) / length)) : 0;
  };
  const calls: { x: number; output: number | null }[] = [];
  for (const r of open.requests.values()) {
    if (!ids.has(r.agentId)) continue;
    const x = at(r.startedAt);
    if (x === null) continue;
    calls.push({ x, output: r.usage ? r.usage.output : null });
  }
  const max = Math.max(0, ...calls.map((c) => c.output ?? 0));
  const tools: StripMark[] = [];
  for (const t of open.toolCalls.values()) {
    if (!ids.has(t.agentId)) continue;
    const x = at(t.startedAt);
    if (x !== null) tools.push({ x });
  }
  const byX = <T extends StripMark>(marks: T[]): T[] => marks.sort((a, b) => a.x - b.x);
  return {
    span,
    turns: byX(turnStarts.map((s) => ({ x: at(new Date(s).toISOString()) ?? 0 }))),
    calls: byX(
      calls.map((c) => ({
        x: c.x,
        h: c.output !== null && max > 0 ? c.output / max : 0,
        hollow: c.output === null,
      })),
    ),
    tools: byX(tools),
  };
}
