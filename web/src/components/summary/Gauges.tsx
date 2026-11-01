import type { ActivityStrip as Strip } from '../../lib/activity';
import { DASH, formatCompact, formatNumber } from '../../lib/format';
import { CompactFigure } from '../CompactFigure';
import css from './Gauges.module.css';

/** The ring's radius in its 36-unit box; its stroke is 3.5. */
const R = 15;
const CIRCUMFERENCE = 2 * Math.PI * R;

export type RingTone = 'muted' | 'plain' | 'warn' | 'ok';

/**
 * A share as a ring: the arc from the top, clockwise, over a track, the percent rounded down
 * inside. Drawn only: what it means is said by the cell that holds it.
 */
export function Ring({ pct, tone }: { pct: number; tone: RingTone }) {
  const share = Math.min(100, Math.max(0, pct));
  return (
    <svg
      className={css.ring}
      viewBox="0 0 36 36"
      width="36"
      height="36"
      aria-hidden="true"
      data-tone={tone}
      data-pct={Math.floor(share)}
    >
      <circle className={css.track} cx="18" cy="18" r={R} />
      <circle
        className={css.arc}
        cx="18"
        cy="18"
        r={R}
        strokeDasharray={`${(CIRCUMFERENCE * share) / 100} ${CIRCUMFERENCE}`}
        transform="rotate(-90 18 18)"
        data-arc
      />
      <text className={css.pct} x="18" y="21.5" textAnchor="middle">
        {Math.floor(share)}%
      </text>
    </svg>
  );
}

/** The strip's height, and where its baseline sits: bars grow up from it, ticks hang under. */
const H = 30;
const BASE = 22;
/** Margin at each end, so a mark at 0 or 1 is whole. */
const INSET = 4;

/**
 * The agent's span as a strip: a bar per model call (height by its output, hollow before
 * usage), a triangle per turn at the top, a tick per tool call under the baseline.
 */
export function ActivityStrip({ strip, width }: { strip: Strip; width: number }) {
  const px = (x: number) => INSET + x * (width - 2 * INSET);
  return (
    <svg
      className={css.strip}
      viewBox={`0 0 ${width} ${H}`}
      width={width}
      height={H}
      aria-hidden="true"
    >
      <line className={css.base} x1="0" y1={BASE + 0.5} x2={width} y2={BASE + 0.5} data-base />
      {strip.calls.map((c, i) => {
        const h = c.hollow ? 3 : 3 + c.h * 13;
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: marks in start order, never reordered
            key={i}
            className={c.hollow ? css.hollow : css.call}
            x={px(c.x) - 1}
            y={BASE - h}
            width="2"
            height={h}
            data-call={c.hollow ? 'hollow' : 'full'}
          />
        );
      })}
      {strip.tools.map((m, i) => (
        <rect
          // biome-ignore lint/suspicious/noArrayIndexKey: marks in start order, never reordered
          key={i}
          className={css.tool}
          x={px(m.x) - 0.5}
          y={BASE + 2}
          width="1"
          height="4"
          data-tool
        />
      ))}
      {strip.turns.map((m, i) => {
        const x = px(m.x);
        return (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: marks in start order, never reordered
            key={i}
            className={css.turn}
            d={`M${x - 3.5} 0 L${x + 3.5} 0 L${x} 6 Z`}
            data-turn
          />
        );
      })}
    </svg>
  );
}

const pctOf = (part: number, whole: number) =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '0%';

/**
 * Two bars: the input with its cached share hatched, the output with its thinking share in the
 * accent; the compact total at the right of each, the exact count in its tooltip. Before any
 * usage, empty tracks and dashes.
 */
export function TokenBars({
  input,
  cached,
  output,
  thinking,
  measured,
  intl,
  width,
  labels = { in: 'in', out: 'out' },
}: {
  input: number;
  cached: number;
  output: number;
  thinking: number;
  measured: boolean;
  intl: string;
  width: number;
  labels?: { in: string; out: string };
}) {
  const total = (n: number, exact: string) => (
    <span className={`${css.total} figure`} data-total title={measured ? exact : undefined}>
      {measured ? <CompactFigure value={formatCompact(n, intl)} /> : DASH}
    </span>
  );
  return (
    <div className={css.bars} aria-hidden="true">
      <div className={css.bar} data-bar="in">
        <span className={css.barLabel}>{labels.in}</span>
        <span className={css.track} style={{ width }} data-track>
          {measured && (
            <>
              <i
                className={css.cached}
                style={{ width: pctOf(cached, input) }}
                data-part="cached"
              />
              <i
                className={css.fresh}
                style={{ left: pctOf(cached, input), width: pctOf(input - cached, input) }}
                data-part="fresh"
              />
            </>
          )}
        </span>
        {total(input, formatNumber(input, intl))}
      </div>
      <div className={css.bar} data-bar="out">
        <span className={css.barLabel}>{labels.out}</span>
        <span className={css.track} style={{ width }} data-track>
          {measured && (
            <>
              <i className={css.outAll} data-part="output" />
              <i
                className={css.thinking}
                style={{ width: pctOf(thinking, output) }}
                data-part="thinking"
              />
            </>
          )}
        </span>
        {total(output, `${formatNumber(output, intl)} (${formatNumber(thinking, intl)})`)}
      </div>
    </div>
  );
}
