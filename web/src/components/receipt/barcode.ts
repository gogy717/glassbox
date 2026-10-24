/**
 * The receipt's barcode is the session's timeline: x is its active time (idle gaps squeezed),
 * each pixel column takes the kind of work that filled most of it, and runs of one kind merge
 * into one bar. Only aggregation happens here; the segments are the Timeline's own.
 */
import { buildTimeScale, type Segment } from '../../lib/time-stats';

export type BarKind = 'thinking' | 'generating' | 'tool' | 'approval' | 'fail';
export interface Bar {
  x: number;
  w: number;
  kind: BarKind;
}
export interface Barcode {
  bars: Bar[];
  /** Where a long idle gap was squeezed: an x on the axis, marked "//". */
  breaks: number[];
  /** Sub-agents' lifetimes, one track each; `more` of them merged into the last. */
  tracks: { x: number; w: number }[];
  more: number;
}

/** Bar heights by kind: the taller, the more the model was at work. */
export const BAR_HEIGHT: Record<BarKind, number> = {
  thinking: 42,
  generating: 29,
  tool: 16,
  fail: 16,
  approval: 3,
};

/** A single idle gap over this share of the span is squeezed to this share of the width. */
const GAP_SHARE = 0.02;
const MAX_TRACKS = 6;

export function barcode(
  segments: Segment[],
  subAgents: [number, number][],
  failedTools: ReadonlySet<string>,
  width = 316,
): Barcode {
  const intervals: [number, number][] = [
    ...segments.map((s) => [s.start, s.end] as [number, number]),
    ...subAgents,
  ];
  if (intervals.length === 0) return { bars: [], breaks: [], tracks: [], more: 0 };
  const from = Math.min(...intervals.map(([a]) => a));
  const to = Math.max(...intervals.map(([, b]) => b));
  const gapMs = Math.max(1, (to - from) * GAP_SHARE);
  // First the active time alone, then a scale where it and the squeezed gaps fill the width.
  const raw = buildTimeScale(intervals, { pxPerMs: 1, gapMs, breakPx: 0 });
  const gaps = raw.breaks.length;
  const breakPx = gaps ? Math.min(width * GAP_SHARE, (width * 0.5) / gaps) : 0;
  const pxPerMs = raw.width > 0 ? (width - gaps * breakPx) / raw.width : 0;
  const scale = buildTimeScale(intervals, { pxPerMs, gapMs, breakPx });

  // Per column: how much of it each kind covers. Queued time and idle compete but draw nothing.
  const kinds = ['thinking', 'generating', 'tool', 'fail', 'approval', 'waiting'] as const;
  const cover = new Map<(typeof kinds)[number], Float64Array>(
    kinds.map((k) => [k, new Float64Array(width)]),
  );
  for (const s of segments) {
    const kind = s.kind === 'tool' && failedTools.has(s.refId) ? 'fail' : s.kind;
    const col = cover.get(kind) as Float64Array;
    const x0 = Math.max(0, scale.x(s.start));
    const x1 = Math.min(width, scale.x(s.end));
    for (let c = Math.floor(x0); c < x1 && c < width; c++)
      col[c] = (col[c] ?? 0) + Math.min(x1, c + 1) - Math.max(x0, c);
  }
  const column: (BarKind | null)[] = [];
  for (let c = 0; c < width; c++) {
    let best: BarKind | null = null;
    let most = 0;
    let covered = 0;
    for (const k of kinds) {
      const v = (cover.get(k) as Float64Array)[c] ?? 0;
      covered += v;
      if (v > most) {
        most = v;
        best = k === 'waiting' ? null : k;
      }
    }
    column.push(most > 0 && most >= 1 - covered ? best : null);
  }
  const bars: Bar[] = [];
  for (let c = 0; c < width; c++) {
    const kind = column[c];
    if (!kind) continue;
    const last = bars.at(-1);
    if (last && last.kind === kind && last.x + last.w === c) last.w++;
    else bars.push({ x: c, w: 1, kind });
  }

  const span = ([a, b]: [number, number]) => {
    const x = scale.x(a);
    return { x, w: Math.max(1, scale.x(b) - x) };
  };
  const sorted = [...subAgents].sort((p, q) => p[0] - q[0]);
  const shown = sorted.length > MAX_TRACKS ? sorted.slice(0, MAX_TRACKS - 1) : sorted;
  const rest = sorted.slice(shown.length);
  const tracks = shown.map(span);
  if (rest.length > 0)
    tracks.push(span([Math.min(...rest.map(([a]) => a)), Math.max(...rest.map(([, b]) => b))]));
  return {
    bars,
    breaks: scale.breaks.map((b) => (b.x0 + b.x1) / 2),
    tracks,
    more: rest.length,
  };
}
