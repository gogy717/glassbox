/**
 * The receipt's barcode is the session's timeline: x is its active time (idle gaps squeezed),
 * each pixel column takes the kind of work that filled most of it (the main agent's, or while
 * it waits on sub-agents, the busiest one's), and runs of one kind merge into one bar. Only
 * aggregation happens here; the segments are the Timeline's own.
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

/** No idle gap may take more than this share of the width: longer ones are squeezed to it. */
const GAP_SHARE = 0.02;
const DRAWN: BarKind[] = ['thinking', 'generating', 'tool', 'fail', 'approval'];
const MAX_TRACKS = 6;

/**
 * The idle gaps to squeeze: every one that, drawn to scale, would be wider than its squeezed
 * width. Squeezing the longest stretches the rest, so it repeats until none is left over.
 * Returns the longest gap left to scale (buildTimeScale's `gapMs`) and the squeezed width.
 */
function squeeze(intervals: [number, number][], width: number) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const gaps: number[] = [];
  let end = sorted[0]?.[1] ?? 0;
  let busy = 0;
  let start = sorted[0]?.[0] ?? 0;
  for (const [a, b] of sorted) {
    if (a > end) {
      busy += end - start;
      gaps.push(a - end);
      start = a;
    }
    end = Math.max(end, b);
  }
  busy += end - start;
  gaps.sort((a, b) => b - a);
  let squeezed = 0;
  let breakPx = 0;
  for (;;) {
    breakPx = squeezed ? Math.min(width * GAP_SHARE, (width * 0.5) / squeezed) : width * GAP_SHARE;
    const kept = busy + gaps.slice(squeezed).reduce((s, g) => s + g, 0);
    const pxPerMs = kept > 0 ? (width - squeezed * breakPx) / kept : 0;
    const next = gaps[squeezed];
    if (next === undefined || next * pxPerMs <= breakPx) break;
    squeezed++;
  }
  // buildTimeScale squeezes the gaps longer than gapMs: halfway between the shortest squeezed
  // gap and the longest kept one (subtracting a hair from a 300-day gap in ms changes nothing).
  const gapMs = squeezed
    ? ((gaps[squeezed - 1] as number) + (gaps[squeezed] ?? 0)) / 2
    : Number.POSITIVE_INFINITY;
  return { gapMs, breakPx: squeezed ? breakPx : 0 };
}

/**
 * `subSegments` are the sub-agents' own timelines, one per sub-agent (`subAgents` their spans):
 * a column the main agent leaves empty while they work takes the busiest one's kind of work.
 */
export function barcode(
  segments: Segment[],
  subAgents: [number, number][],
  failedTools: ReadonlySet<string>,
  width = 316,
  subSegments: Segment[][] = [],
): Barcode {
  const span = (s: Segment) => [s.start, s.end] as [number, number];
  const intervals: [number, number][] = [
    ...segments.map(span),
    ...subAgents,
    ...subSegments.flat().map(span),
  ];
  if (intervals.length === 0) return { bars: [], breaks: [], tracks: [], more: 0 };
  const { gapMs, breakPx } = squeeze(intervals, width);
  const raw = buildTimeScale(intervals, { pxPerMs: 1, gapMs, breakPx: 0 });
  const pxPerMs = raw.width > 0 ? (width - raw.breaks.length * breakPx) / raw.width : 0;
  const scale = buildTimeScale(intervals, { pxPerMs, gapMs, breakPx });

  // Per column: how much of it each kind covers. Queued time and idle compete but draw nothing.
  const kinds = ['thinking', 'generating', 'tool', 'fail', 'approval', 'waiting'] as const;
  type Cover = Map<(typeof kinds)[number], Float64Array>;
  const add = (col: Float64Array, start: number, end: number) => {
    const x0 = Math.max(0, scale.x(start));
    const x1 = Math.min(width, scale.x(end));
    for (let c = Math.floor(x0); c < x1 && c < width; c++)
      col[c] = (col[c] ?? 0) + Math.min(x1, c + 1) - Math.max(x0, c);
  };
  const coverOf = (lane: Segment[]): Cover => {
    const cover: Cover = new Map(kinds.map((k) => [k, new Float64Array(width)]));
    for (const s of lane) {
      const kind = s.kind === 'tool' && failedTools.has(s.refId) ? 'fail' : s.kind;
      add(cover.get(kind) as Float64Array, s.start, s.end);
    }
    return cover;
  };
  /** The kind covering most of column `c`, how much it covers, and how much all kinds do. */
  const dominant = (cover: Cover, c: number) => {
    let kind: BarKind | null = null;
    let most = 0;
    let covered = 0;
    for (const k of kinds) {
      const v = (cover.get(k) as Float64Array)[c] ?? 0;
      covered += v;
      if (v > most) {
        most = v;
        kind = k === 'waiting' ? null : k;
      }
    }
    return { kind, most, covered };
  };
  const main = coverOf(segments);
  const subs = subSegments.map(coverOf);
  // A sub-agent at work while the main agent waits on it is work too.
  const delegated = new Float64Array(width);
  for (const [a, b] of subAgents) add(delegated, a, b);
  const column: (BarKind | null)[] = [];
  for (let c = 0; c < width; c++) {
    const own = dominant(main, c);
    if (own.most > 0 && own.most >= 1 - own.covered) column.push(own.kind);
    else if (own.covered > 0) column.push(null);
    else {
      // The busiest sub-agent's work, drawn as the main agent's would be (thinking tall, a tool
      // low); while none has any, the sub-agents' lives are still a tool's low bar.
      let busiest: BarKind | null = null;
      let most = 0;
      for (const sub of subs) {
        let top: BarKind | null = null;
        let topV = 0;
        let work = 0;
        for (const k of DRAWN) {
          const v = (sub.get(k) as Float64Array)[c] ?? 0;
          work += v;
          if (v > topV) {
            topV = v;
            top = k;
          }
        }
        if (top && work > most) {
          most = work;
          busiest = top;
        }
      }
      const alive = (delegated[c] ?? 0) >= 0.5;
      column.push(busiest && (alive || most >= 0.5) ? busiest : alive ? 'tool' : null);
    }
  }
  const bars: Bar[] = [];
  for (let c = 0; c < width; c++) {
    const kind = column[c];
    if (!kind) continue;
    const last = bars.at(-1);
    if (last && last.kind === kind && last.x + last.w === c) last.w++;
    else bars.push({ x: c, w: 1, kind });
  }

  const track = ([a, b]: [number, number]) => {
    const x = scale.x(a);
    return { x, w: Math.max(1, scale.x(b) - x) };
  };
  const sorted = [...subAgents].sort((p, q) => p[0] - q[0]);
  const shown = sorted.length > MAX_TRACKS ? sorted.slice(0, MAX_TRACKS - 1) : sorted;
  const rest = sorted.slice(shown.length);
  const tracks = shown.map(track);
  if (rest.length > 0)
    tracks.push(track([Math.min(...rest.map(([a]) => a)), Math.max(...rest.map(([, b]) => b))]));
  return {
    bars,
    breaks: scale.breaks.map((b) => (b.x0 + b.x1) / 2),
    tracks,
    more: rest.length,
  };
}
