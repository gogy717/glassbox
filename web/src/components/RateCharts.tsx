/** The token rate's charts: a line of the last hour, small in the bar and the rows, large in the popover. */
import { MINUTE_MS, RATE_MINUTES, type TokenRate } from '../../../src/shared/rate.js';
import { compactUnit, formatCompact } from '../lib/format';
import { SvgUiCjk } from './CompactFigure';

/** A small line needs this many counted minutes (two whole ones and the current) to say anything. */
export const SPARK_MIN_POINTS = 3;
/** Its axis never spans fewer minutes than this, so a young line does not stretch over the box. */
const SPARK_MIN_SLOTS = 10;

/**
 * A series as a 1px line in the current colour, no fill, no dots: the counted minutes from `from`,
 * right-aligned on an axis of max(10, counted) minutes. Nothing under three points: a line of one
 * or two reads as a fault.
 */
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
  const shown = values.slice(from);
  if (shown.length < SPARK_MIN_POINTS) return null;
  const slots = Math.max(SPARK_MIN_SLOTS, shown.length);
  const max = Math.max(1, ...shown);
  const x = (j: number) => ((slots - shown.length + j) / (slots - 1)) * (width - 1) + 0.5;
  const y = (v: number) => height - 0.5 - (v / max) * (height - 1);
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      data-points={shown.length}
    >
      <polyline
        points={shown.map((v, j) => `${x(j).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
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

/**
 * The y labels in one unit, the top tick's, as compact notation names it in `locale`
 * ("1.5M / 1.0M / 0.5M / 0", "150万 / 100万 / 50万 / 0"), with the decimals the step needs.
 */
export function axisLabels(step: number, ticks: number, locale?: string): string[] {
  const top = step * ticks;
  const inUnit = step / compactUnit(top, locale).divisor;
  const decimals = Number.isInteger(inUnit) ? 0 : Number.isInteger(inUnit * 10) ? 1 : 2;
  return Array.from({ length: ticks + 1 }, (_, k) =>
    k === 0 ? '0' : formatCompact(k * step, locale, { decimals, unitOf: top }),
  );
}

const LABELS = 34;
const PLOT_W = 300;
const PLOT_H = 96;
const AXIS = 18;
/** Space between the "counting since" rule and its label. */
const SINCE_LABEL_GAP = 6;

/**
 * Width of `text` in the chart's labels, 10px: Plex Mono advances 0.6em for every Latin
 * character, and a CJK character falls back to a full-width face, 1em. SVG text cannot be measured
 * before it is drawn (nor in tests), and these metrics are fixed.
 */
export function labelWidth(text: string, fontSize = 10): number {
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)) wide++;
    else narrow++;
  }
  // In tenths of an em, so twenty narrow characters make 12em exactly.
  return ((wide * 10 + narrow * 6) * fontSize) / 10;
}

/**
 * The hour on a fixed 60-minute axis: a hairline grid with round y labels, "−60 min / −30 / now"
 * under it, a "now" rule with a dot at the latest value, and the line from the first whole
 * counted minute. When counting began within the hour, a rule marks when; with room, it says so.
 * Nothing is drawn for the minutes before: they are unknown, not zero. The figures are in `label`.
 */
export function RateChart({
  rate,
  values,
  from,
  locale,
  label,
  ticksX,
  sinceLabel,
}: {
  rate: TokenRate;
  values: number[];
  from: number;
  locale?: string;
  label: string;
  ticksX: [string, string, string];
  /** "counting since 15:22" when counting began within the hour; null otherwise. */
  sinceLabel: string | null;
}) {
  const shown = values.slice(from);
  const step = niceStep(Math.max(0, ...shown) / 3);
  const labels = axisLabels(step, 3, locale);
  const top = step * 3;
  const x = (i: number) => LABELS + (i / (RATE_MINUTES - 1)) * PLOT_W;
  const y = (v: number) => 4 + (PLOT_H - 4) * (1 - v / top);
  const last = RATE_MINUTES - 1;
  // Where counting began, on the minute axis (bucket i starts `last - i` minutes before `minute`).
  const sinceAt = last - (Date.parse(rate.minute) - Date.parse(rate.since)) / MINUTE_MS;
  // Held between the axis's ends: a clock set back can put `since` after `minute`.
  const sinceX = sinceLabel !== null ? x(Math.min(last, Math.max(0, sinceAt))) : null;
  // Fewer than three points is no line, as for the small ones: the rules and the label say it.
  const drawn = shown.length >= SPARK_MIN_POINTS;
  return (
    <svg
      width={LABELS + PLOT_W}
      height={PLOT_H + AXIS}
      viewBox={`0 0 ${LABELS + PLOT_W} ${PLOT_H + AXIS}`}
      role="img"
      aria-label={label}
      data-chart
    >
      {labels.map((text, k) => (
        <g key={text}>
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
            <SvgUiCjk text={text} />
          </text>
        </g>
      ))}
      {sinceX !== null && (
        <g data-since>
          <line x1={sinceX} x2={sinceX} y1={4} y2={PLOT_H} stroke="var(--muted)" />
          {sinceLabel !== null && sinceX - LABELS >= labelWidth(sinceLabel) + SINCE_LABEL_GAP && (
            <text
              x={sinceX - SINCE_LABEL_GAP}
              y={PLOT_H / 2 + 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--faint)"
              fontFamily="var(--font-mono)"
            >
              <SvgUiCjk text={sinceLabel} />
            </text>
          )}
        </g>
      )}
      <line x1={x(last)} x2={x(last)} y1={4} y2={PLOT_H} stroke="var(--muted)" />
      {drawn && (
        <polyline
          points={shown.map((v, j) => `${x(from + j).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
          fill="none"
          stroke="var(--text)"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      )}
      {drawn && <circle cx={x(last)} cy={y(values[last] ?? 0)} r={2.6} fill="var(--text)" />}
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
          <SvgUiCjk text={tick} />
        </text>
      ))}
    </svg>
  );
}
