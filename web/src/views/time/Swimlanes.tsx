import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MAIN_AGENT_ID } from '../../../../src/core/model.js';
import type { OpenSession } from '../../data/store';
import { useElementWidth } from '../../data/useElementWidth';
import { type MessageKey, useI18n } from '../../i18n';
import { formatClock, formatDuration } from '../../lib/format';
import {
  activeMs,
  breakWidth,
  buildTimeScale,
  type DisplaySeg,
  type Lane,
  mergeForDisplay,
} from '../../lib/time-stats';
import { summarizeInput } from '../../lib/tool-category';
import css from './TimeView.module.css';

interface Props {
  open: OpenSession;
  lanes: Lane[];
  now: number;
  selectedAgentId: string;
  agentName(id: string): string;
  onPick(requestId: string): void;
}

const ROW = 26;
const GROUP = 22;
const AXIS = 28;
const GAP_MS = 60_000;
/** A break label needs about this much room; narrower breaks stay unlabelled (tooltip only). */
const BREAK_LABEL_PX = 56;
const PAD_R = 28;
const ZOOM_STEP = 1.5;
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map(
  (s) => s * 1000,
);

type Row = { kind: 'group'; label: string; y: number } | { kind: 'lane'; lane: Lane; y: number };

const fill = (s: DisplaySeg) =>
  s.kind === 'tool' ? `var(--cat-${s.category ?? 'other'})` : `var(--seg-${s.kind})`;
const MAX_ZOOM = 10_000;

export function Swimlanes({ open, lanes, now, selectedAgentId, agentName, onPick }: Props) {
  const { t } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const viewW = useElementWidth(boxRef, 640);
  const [collapse, setCollapse] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<{ seg: DisplaySeg; lane: Lane } | null>(null);
  const anchor = useRef<{ t: number; cx: number } | null>(null);
  // Bumped on every programmatic zoom so the scroll anchor applies even if the zoom is unchanged.
  const [nav, setNav] = useState(0);

  const intervals = useMemo(
    () => lanes.flatMap((l) => l.segments.map((s) => [s.start, s.end] as [number, number])),
    [lanes],
  );
  const gapMs = collapse ? GAP_MS : Number.POSITIVE_INFINITY;
  // "Fit" fills the visible width; zoom multiplies it.
  const { fitPxPerMs, breakPx } = useMemo(() => {
    const raw = buildTimeScale(intervals, { pxPerMs: 1, gapMs, breakPx: 0 });
    const bp = breakWidth(viewW, raw.breaks.length);
    const room = viewW - PAD_R - raw.breaks.length * bp;
    return { fitPxPerMs: Math.max(1e-7, room / Math.max(1, raw.width)), breakPx: bp };
  }, [intervals, gapMs, viewW]);
  const scale = useMemo(
    () => buildTimeScale(intervals, { pxPerMs: fitPxPerMs * zoom, gapMs, breakPx }),
    [intervals, fitPxPerMs, zoom, gapMs, breakPx],
  );

  // Only what is near the viewport is drawn: zoomed far in, a long session has thousands of rects.
  const [viewLeft, setViewLeft] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setViewLeft(el.scrollLeft));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);
  const inView = (x0: number, x1: number) => x1 >= viewLeft - viewW && x0 <= viewLeft + 2 * viewW;

  // Level of detail: recomputed for the current pixel scale.
  const display = useMemo(
    () => new Map(lanes.map((l) => [l.agentId, mergeForDisplay(l.segments, scale.x)])),
    [lanes, scale],
  );

  const zoomTo = (t0: number, t1: number) => {
    const raw = buildTimeScale(intervals, { pxPerMs: 1, gapMs, breakPx: 0 });
    const activeInRange = Math.max(1, raw.x(t1) - raw.x(t0));
    const breaksIn = raw.breaks.filter((b) => b.from >= t0 && b.to <= t1).length;
    const target = viewW * 0.92 - PAD_R - breaksIn * breakPx;
    anchor.current = { t: t0, cx: viewW * 0.04 };
    setZoom(Math.min(MAX_ZOOM, Math.max(1, target / (activeInRange * fitPxPerMs))));
    setNav((n) => n + 1);
  };
  const zoomToLane = (lane: Lane) => {
    if (lane.segments.length === 0) return;
    zoomTo(
      Math.min(...lane.segments.map((s) => s.start)),
      Math.max(...lane.segments.map((s) => s.end)),
    );
  };

  // Picking a sub-agent (breadcrumb, lane label) frames its active time; main shows everything.
  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of agent re-frames
  useEffect(() => {
    if (selectedAgentId === MAIN_AGENT_ID) return;
    const lane = lanesRef.current.find((l) => l.agentId === selectedAgentId);
    if (lane) zoomToLane(lane);
  }, [selectedAgentId]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    let y = AXIS;
    let group: string | null = null;
    for (const lane of lanes) {
      if (lane.group && lane.group !== group) {
        out.push({ kind: 'group', label: lane.group, y });
        y += GROUP;
      }
      group = lane.group;
      out.push({ kind: 'lane', lane, y });
      y += ROW;
    }
    return { rows: out, height: y + 4 };
  }, [lanes]);

  const ticks = useMemo(() => {
    const pxPerMs = fitPxPerMs * zoom;
    const step = TICK_STEPS.find((s) => s * pxPerMs >= 96) ?? (TICK_STEPS.at(-1) as number);
    const pieces: [number, number][] = [];
    let from = scale.start;
    for (const b of scale.breaks) {
      pieces.push([from, b.from]);
      from = b.to;
    }
    pieces.push([from, scale.end]);
    const out: number[] = [];
    for (const [a, b] of pieces)
      for (let v = Math.ceil(a / step) * step; v <= b && out.length < 400; v += step) out.push(v);
    return out;
  }, [scale, fitPxPerMs, zoom]);

  // Zooming around the cursor: keep the time under the pointer where it was.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nav re-applies an anchor at an unchanged zoom
  useLayoutEffect(() => {
    const el = boxRef.current;
    const a = anchor.current;
    if (!el || !a) return;
    el.scrollLeft = Math.max(0, scale.x(a.t) - a.cx);
    setViewLeft(el.scrollLeft);
    anchor.current = null;
  }, [scale, nav]);

  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const cx = e.clientX - el.getBoundingClientRect().left;
      anchor.current = { t: scaleRef.current.t(cx + el.scrollLeft), cx };
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(0.25, z * (e.deltaY < 0 ? 1.25 : 0.8))));
    };
    let drag: { x: number; left: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as Element).closest('[data-ref]')) return;
      drag = { x: e.clientX, left: el.scrollLeft };
      el.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (drag) el.scrollLeft = drag.left - (e.clientX - drag.x);
    };
    const onUp = () => {
      drag = null;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
  }, []);

  const zoomBy = (f: number) => {
    const el = boxRef.current;
    if (el) {
      const cx = el.clientWidth / 2;
      anchor.current = { t: scale.t(cx + el.scrollLeft), cx };
    }
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(0.25, z * f)));
  };

  const width = Math.ceil(scale.width + PAD_R);
  const live = lanes.some((l) => l.segments.some((s) => s.live));
  const segLabel = (s: DisplaySeg) => {
    if (s.merged)
      return t('time.merged', {
        requests: s.requests,
        tools: s.tools,
        total: formatDuration(s.busyMs),
      });
    if (s.kind === 'approval')
      // Fits a prompt still open and one answered earlier alike.
      return `${open.toolCalls.get(s.refId)?.name ?? ''} · ${t('time.approval')}`;
    if (s.kind !== 'tool') return t(`time.${s.kind}` as MessageKey);
    return (
      open.toolCalls.get(s.refId)?.name ??
      t('time.toolCat', { cat: t(`steps.cat.${s.category ?? 'other'}` as MessageKey) })
    );
  };
  const hoverTool =
    hover && !hover.seg.merged && hover.seg.kind === 'tool'
      ? open.toolCalls.get(hover.seg.refId)
      : undefined;
  const approval = lanes.some((l) => l.segments.some((s) => s.kind === 'approval'));
  const legendKinds = ['thinking', 'generating', 'waiting', ...(approval ? ['approval'] : [])] as (
    | 'thinking'
    | 'generating'
    | 'waiting'
    | 'approval'
  )[];

  return (
    <section className={css.card} aria-labelledby="time-lanes">
      <div className={css.lanesHead}>
        <h3 id="time-lanes">{t('time.lanes')}</h3>
        <ul className={css.legend} aria-label={t('time.legend')}>
          {legendKinds.map((k) => (
            <li key={k}>
              <span
                className={css.swatch}
                style={{ background: `var(--seg-${k})` }}
                aria-hidden="true"
              />
              <span className={css.legendLabel}>{t(`time.${k}`)}</span>
            </li>
          ))}
        </ul>
        <span className={css.hint}>{t('time.hint')}</span>
        <div className={css.tools}>
          <button
            type="button"
            className={css.toggle}
            aria-pressed={collapse}
            onClick={() => setCollapse(!collapse)}
          >
            {t('time.collapseIdle')}
          </button>
          <button
            type="button"
            aria-label={t('time.zoomOut')}
            title={t('time.zoomOut')}
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            <ZoomOut size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t('time.zoomIn')}
            title={t('time.zoomIn')}
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <ZoomIn size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t('time.fit')}
            title={t('time.fit')}
            onClick={() => {
              setZoom(1);
              if (boxRef.current) boxRef.current.scrollLeft = 0;
            }}
          >
            <Maximize2 size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className={css.lanes}>
        <ul className={css.labels} aria-label={t('time.agents')} style={{ paddingTop: AXIS }}>
          {rows.rows.map((r) =>
            r.kind === 'group' ? (
              <li key={`g:${r.label}:${r.y}`} className={css.groupLabel} style={{ height: GROUP }}>
                {r.label}
              </li>
            ) : (
              <li key={r.lane.agentId} className={css.laneLabel} style={{ height: ROW }}>
                <button
                  type="button"
                  aria-current={r.lane.agentId === selectedAgentId ? 'true' : undefined}
                  title={r.lane.label}
                  onClick={() => zoomToLane(r.lane)}
                >
                  {r.lane.agentId === MAIN_AGENT_ID ? t('crumb.main') : r.lane.label}
                </button>
              </li>
            ),
          )}
        </ul>
        <div className={css.chartScroll} ref={boxRef} data-scroll-region>
          <svg
            width={width}
            height={rows.height}
            role="img"
            aria-label={t('time.chartLabel')}
            className={css.svg}
            onMouseLeave={() => setHover(null)}
          >
            {rows.rows.map((r) =>
              r.kind === 'lane' && r.lane.agentId === selectedAgentId ? (
                <rect key="sel" className={css.selBand} x={0} y={r.y} width={width} height={ROW} />
              ) : null,
            )}
            {ticks.map((v) => (
              <g key={v}>
                <line
                  className={css.tick}
                  x1={scale.x(v)}
                  x2={scale.x(v)}
                  y1={AXIS - 6}
                  y2={rows.height}
                />
                {/* Leave room for the "now" label and labelled breaks. */}
                {!(live && Math.abs(scale.x(v) - scale.x(now)) < 64) &&
                  !(
                    breakPx >= BREAK_LABEL_PX &&
                    scale.breaks.some((b) => Math.abs(scale.x(v) - (b.x0 + b.x1) / 2) < 70)
                  ) && (
                    <text className={css.tickLabel} x={scale.x(v) + 3} y={AXIS - 10}>
                      {formatClock(new Date(v).toISOString())}
                    </text>
                  )}
              </g>
            ))}
            {scale.breaks.map((b) => (
              <g key={b.from}>
                <rect
                  className={css.break}
                  x={b.x0}
                  y={AXIS - 6}
                  width={b.x1 - b.x0}
                  height={rows.height}
                >
                  {/* Narrow breaks have no room for a label; the native tooltip carries it. */}
                  {breakPx < BREAK_LABEL_PX && (
                    <title>{t('time.gap', { t: formatDuration(b.to - b.from) })}</title>
                  )}
                </rect>
                {breakPx >= BREAK_LABEL_PX && (
                  <text
                    className={css.breakLabel}
                    x={(b.x0 + b.x1) / 2}
                    y={AXIS - 10}
                    textAnchor="middle"
                  >
                    {t('time.gap', { t: formatDuration(b.to - b.from) })}
                  </text>
                )}
              </g>
            ))}
            {rows.rows.map((r) =>
              r.kind === 'lane' ? (
                <g key={r.lane.agentId} data-lane={r.lane.agentId}>
                  {(display.get(r.lane.agentId) ?? []).map((d) => {
                    if (!inView(d.x0, d.x1)) return null;
                    const short = d.kind === 'tool' && !d.merged;
                    return (
                      // biome-ignore lint/a11y/noStaticElementInteractions: the slowest-steps list is the keyboard path
                      <rect
                        key={`${d.merged ? 'm' : d.kind}:${d.refId}:${d.start}`}
                        data-ref={d.merged ? undefined : d.refId}
                        data-kind={d.kind}
                        data-merged={d.merged || undefined}
                        data-live={d.live || undefined}
                        className={css.seg}
                        x={d.x0}
                        y={short ? r.y + 12 : r.y + 4}
                        width={d.x1 - d.x0}
                        height={short ? 10 : 18}
                        rx={2}
                        fill={fill(d)}
                        onMouseEnter={() => setHover({ seg: d, lane: r.lane })}
                        onClick={() => (d.merged ? zoomTo(d.start, d.end) : onPick(d.requestId))}
                      />
                    );
                  })}
                </g>
              ) : null,
            )}
            {live && (
              <g>
                <line
                  className={css.nowLine}
                  x1={scale.x(now)}
                  x2={scale.x(now)}
                  y1={AXIS - 6}
                  y2={rows.height}
                />
                <text className={css.nowLabel} x={scale.x(now) - 4} y={AXIS - 10} textAnchor="end">
                  {t('time.now')}
                </text>
              </g>
            )}
          </svg>
          {hover && (
            <div
              role="tooltip"
              className={css.tooltip}
              style={{
                left: Math.min(scale.x(hover.seg.start), width - 220),
                top:
                  (rows.rows.find((r) => r.kind === 'lane' && r.lane === hover.lane)?.y ?? 0) + ROW,
              }}
            >
              <strong>{segLabel(hover.seg)}</strong>
              <span>{agentName(hover.lane.agentId)}</span>
              {hoverTool && <code>{summarizeInput(hoverTool)}</code>}
              <span className="num">
                {formatClock(new Date(hover.seg.start).toISOString())} ·{' '}
                {formatDuration(hover.seg.end - hover.seg.start)}
                {hover.seg.live ? ` · ${t('time.live')}` : ''}
              </span>
            </div>
          )}
        </div>
        <ul className={css.totals} aria-label={t('time.activeTime')} style={{ paddingTop: AXIS }}>
          {rows.rows.map((r) =>
            r.kind === 'group' ? (
              <li key={`g:${r.label}:${r.y}`} style={{ height: GROUP }} aria-hidden="true" />
            ) : (
              <li key={r.lane.agentId} className="num" style={{ height: ROW }}>
                {formatDuration(activeMs(r.lane.segments))}
              </li>
            ),
          )}
        </ul>
      </div>
    </section>
  );
}
