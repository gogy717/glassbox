/** The token rate's charts: a line of the last hour, small in the bar and the rows, large in the popover. */
import { MINUTE_MS, RATE_MINUTES, type TokenRate } from '../../../src/shared/rate.js';

/**
 * Index of the first minute bucket counted: the server started within the hour, and the minutes
 * before it are unknown, not idle, so the line starts there.
 */
export function firstCounted(rate: TokenRate): number {
  const minute = Date.parse(rate.minute);
  const since = Math.floor(Date.parse(rate.since) / MINUTE_MS) * MINUTE_MS;
  const index = RATE_MINUTES - 1 - Math.round((minute - since) / MINUTE_MS);
  return Math.min(RATE_MINUTES - 1, Math.max(0, index));
}

const points = (
  values: number[],
  from: number,
  x: (i: number) => number,
  y: (v: number) => number,
) =>
  values
    .map((v, i) => [i, v] as const)
    .slice(from)
    .map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(' ');

/** A series as a 1px line in the current colour: no fill, no dots. */
export function Sparkline({
  values,
  width,
  height,
  from = 0,
  className,
}: {
  values: number[];
  width: number;
  height: number;
  from?: number;
  className?: string;
}) {
  const max = Math.max(1, ...values);
  const x = (i: number) => (i / (values.length - 1)) * (width - 1) + 0.5;
  const y = (v: number) => height - 0.5 - (v / max) * (height - 1);
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <polyline
        points={points(values, from, x, y)}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A step of 1, 2, 2.5 or 5 × 10ⁿ: the y axis reads in round figures. */
export function niceStep(span: number): number {
  if (!(span > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(span));
  const unit = span / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power;
}

const LABELS = 34;
const PLOT_W = 300;
const PLOT_H = 96;
const AXIS = 18;

/**
 * The hour as a line on a hairline grid, with round y labels, "−60 min / −30 / now" under it,
 * and a "now" rule with a dot at the latest value. The figures are in `label`.
 */
export function RateChart({
  values,
  from,
  format,
  label,
  ticksX,
}: {
  values: number[];
  from: number;
  format: (n: number) => string;
  label: string;
  ticksX: [string, string, string];
}) {
  const step = niceStep(Math.max(...values) / 3);
  const top = step * 3;
  const x = (i: number) => LABELS + (i / (values.length - 1)) * PLOT_W;
  const y = (v: number) => 4 + (PLOT_H - 4) * (1 - v / top);
  const last = values.length - 1;
  return (
    <svg
      width={LABELS + PLOT_W}
      height={PLOT_H + AXIS}
      viewBox={`0 0 ${LABELS + PLOT_W} ${PLOT_H + AXIS}`}
      role="img"
      aria-label={label}
      data-chart
    >
      {[0, 1, 2, 3].map((k) => (
        <g key={k}>
          <line
            x1={LABELS}
            x2={LABELS + PLOT_W}
            y1={y(k * step)}
            y2={y(k * step)}
            stroke="var(--border)"
          />
          <text
            x={LABELS - 6}
            y={y(k * step) + 3}
            textAnchor="end"
            fontSize={10}
            fill="var(--faint)"
            fontFamily="var(--font-mono)"
          >
            {format(k * step)}
          </text>
        </g>
      ))}
      <line x1={x(last)} x2={x(last)} y1={4} y2={PLOT_H} stroke="var(--muted)" />
      <polyline
        points={points(values, from, x, y)}
        fill="none"
        stroke="var(--text)"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      <circle cx={x(last)} cy={y(values[last] ?? 0)} r={1.6} fill="var(--text)" />
      {ticksX.map((tick, k) => (
        <text
          key={tick}
          x={k === 0 ? LABELS : k === 1 ? LABELS + PLOT_W / 2 : LABELS + PLOT_W}
          y={PLOT_H + AXIS - 4}
          textAnchor={k === 0 ? 'start' : k === 1 ? 'middle' : 'end'}
          fontSize={10}
          fill={k === 2 ? 'var(--muted)' : 'var(--faint)'}
          fontFamily="var(--font-mono)"
        >
          {tick}
        </text>
      ))}
    </svg>
  );
}
