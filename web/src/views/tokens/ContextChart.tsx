import { useMemo, useRef, useState } from 'react';
import { useElementWidth } from '../../data/useElementWidth';
import { useI18n } from '../../i18n';
import { formatCompact, formatNumber } from '../../lib/format';
import type { ContextPoint } from '../../lib/token-stats';
import css from './TokensView.module.css';

const H = 200;
const PAD = { l: 48, r: 14, t: 12, b: 26 };
/** Room for one x-axis label ("#156") and the space after it. */
export const LABEL_GAP = 48;

/** Where point `i` of `count` sits across a chart `width` wide. */
export function labelX(i: number, count: number, width: number): number {
  const innerW = Math.max(1, width - PAD.l - PAD.r);
  return PAD.l + (count > 1 ? (i * innerW) / (count - 1) : innerW / 2);
}

/**
 * Which points get an x-axis label: every few, and always the last, so the reader sees how far
 * the session got. A regular label too close to the last one is dropped instead of overlapping it.
 */
export function axisLabels(count: number, width: number): number[] {
  if (count <= 0) return [];
  const last = count - 1;
  const end = labelX(last, count, width);
  const step = last > 0 ? (end - labelX(0, count, width)) / last : 0;
  const every = step > 0 ? Math.max(1, Math.ceil(LABEL_GAP / step)) : 1;
  const out: number[] = [];
  for (let i = 0; i < last; i += every) if (end - labelX(i, count, width) >= LABEL_GAP) out.push(i);
  out.push(last);
  return out;
}

/** Round up to 1, 2 or 5 × 10^k so gridlines land on readable values. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

interface Props {
  /** Whose context this is: "Main", or a sub-agent's name. */
  agent: string;
  points: ContextPoint[];
  onPick(requestId: string): void;
}

/**
 * Context size per request: a line on a hairline grid, a dot per request (click opens it in the
 * execution chain), compactions as amber dashed rules. No area fill: the line is the data.
 */
export function ContextChart({ agent, points, onPick }: Props) {
  const { t, intl } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(boxRef);
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    const max = niceMax(Math.max(0, ...points.map((p) => p.context)));
    const innerW = Math.max(1, width - PAD.l - PAD.r);
    const step = points.length > 1 ? innerW / (points.length - 1) : 0;
    const x = (i: number) => labelX(i, points.length, width);
    const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.context)}`).join('');
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
    // Each point owns exactly its share of the width, so neighbouring hit areas never overlap.
    return { x, y, line, ticks, slot: points.length > 1 ? step : innerW };
  }, [points, width]);

  const labels = useMemo(() => axisLabels(points.length, width), [points.length, width]);
  // Same numbering as the execution chain, so a point can be found there.
  const ref = (p: ContextPoint) =>
    p.turn === null
      ? `${t('flow.outsideTurns')} · ${t('flow.callTitle', { n: p.call })}`
      : t('tokens.requestRef', { turn: p.turn, n: p.call });
  const hovered = hover === null ? null : points[hover];
  const compacted = points.some((p) => p.compacted);

  return (
    <section className={css.section} aria-labelledby="tok-context">
      <div className={css.sectionHead}>
        <h3 id="tok-context">
          {t('tokens.contextGrowth')} <span className={css.headAgent}>· {agent}</span>
        </h3>
        <span className={css.chartKey} aria-hidden="true">
          {t('tokens.perRequest')}
          {compacted && (
            <>
              {' · '}
              <span className={css.keyDash} />
              {t('tokens.compaction')}
            </>
          )}
        </span>
      </div>
      <div className={css.chartBox} ref={boxRef}>
        <svg
          width={width}
          height={H}
          role="img"
          aria-label={t('tokens.chartLabel')}
          className={css.chart}
          onMouseLeave={() => setHover(null)}
        >
          {geo.ticks.map((v) => (
            <g key={v}>
              <line
                className={css.grid}
                x1={PAD.l}
                x2={width - PAD.r}
                y1={geo.y(v)}
                y2={geo.y(v)}
              />
              <text className={css.axis} x={PAD.l - 6} y={geo.y(v)} textAnchor="end" dy="0.32em">
                {formatCompact(v, intl)}
              </text>
            </g>
          ))}
          {labels.map((i) => (
            <text key={i} className={css.axis} x={geo.x(i)} y={H - 8} textAnchor="middle">
              #{i + 1}
            </text>
          ))}
          {points.map((p, i) =>
            p.compacted ? (
              <g key={`c-${p.requestId}`}>
                <line
                  className={css.compaction}
                  x1={geo.x(i)}
                  x2={geo.x(i)}
                  y1={PAD.t}
                  y2={H - PAD.b}
                />
                <text className={css.compactionLabel} x={geo.x(i) + 4} y={PAD.t + 10}>
                  {t('tokens.compacted')}
                </text>
              </g>
            ) : null,
          )}
          <path className={css.line} d={geo.line} />
          {hovered && hover !== null && (
            <line
              className={css.crosshair}
              x1={geo.x(hover)}
              x2={geo.x(hover)}
              y1={PAD.t}
              y2={H - PAD.b}
            />
          )}
          {points.map((p, i) => (
            <circle
              key={p.requestId}
              className={css.dot}
              data-active={hover === i || undefined}
              cx={geo.x(i)}
              cy={geo.y(p.context)}
              r={hover === i ? 4 : 2.6}
            />
          ))}
          {points.map((p, i) => (
            // Hit targets are full-height columns, much bigger than the dots.
            // biome-ignore lint/a11y/noStaticElementInteractions: the data table below is the accessible path
            <rect
              key={`hit-${p.requestId}`}
              className={css.hit}
              x={geo.x(i) - geo.slot / 2}
              y={0}
              width={geo.slot}
              height={H}
              onMouseEnter={() => setHover(i)}
              onClick={() => onPick(p.requestId)}
            />
          ))}
        </svg>
        {hovered && hover !== null && (
          <div
            role="tooltip"
            className={css.tooltip}
            style={{
              left: Math.min(Math.max(geo.x(hover), 80), width - 80),
              top: Math.max(geo.y(hovered.context) - 12, 0),
            }}
          >
            <strong>{ref(hovered)}</strong>
            <span>
              {t('tokens.context')} {formatNumber(hovered.context, intl)}
            </span>
            <span>
              {t('tokens.output')} {formatNumber(hovered.output, intl)}
            </span>
          </div>
        )}
      </div>
      <table className="visually-hidden">
        <thead>
          <tr>
            <th>{t('tokens.request')}</th>
            <th>{t('tokens.context')}</th>
            <th>{t('tokens.output')}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.requestId}>
              <td>{ref(p)}</td>
              <td>{formatNumber(p.context, intl)}</td>
              <td>{formatNumber(p.output, intl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
