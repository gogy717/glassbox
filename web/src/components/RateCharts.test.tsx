import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MINUTE_MS, RATE_MINUTES, type TokenRate } from '../../../src/shared/rate.js';
import { axisLabels, niceStep, RateChart, Sparkline } from './RateCharts';

const series = (known: number) => [
  ...new Array<number>(RATE_MINUTES - known).fill(0),
  ...Array.from({ length: known }, (_, i) => 100 + i),
];

describe('Sparkline', () => {
  it('draws nothing under three counted minutes', () => {
    const { container } = render(<Sparkline values={series(2)} width={60} height={16} from={58} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('right-aligns a young line on an axis of at least ten minutes', () => {
    const { container } = render(<Sparkline values={series(5)} width={60} height={16} from={55} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('data-points', '5');
    const xs = (svg?.querySelector('polyline')?.getAttribute('points') ?? '')
      .split(' ')
      .map((p) => Number(p.split(',')[0]));
    // Slots 5..9 of 10 across 59 px: from x = 33.3 to the right edge.
    expect(xs[0]).toBeCloseTo((5 / 9) * 59 + 0.5, 1);
    expect(xs.at(-1)).toBeCloseTo(59.5, 1);
  });

  it('spans the box once the hour is known', () => {
    const { container } = render(<Sparkline values={series(60)} width={60} height={16} />);
    const first = container.querySelector('polyline')?.getAttribute('points')?.split(' ')[0];
    expect(Number(first?.split(',')[0])).toBeCloseTo(0.5, 1);
  });
});

describe('RateChart axis', () => {
  it('labels every tick in the top tick’s unit', () => {
    expect(axisLabels(niceStep(1_500_000 / 3), 3, 'en')).toEqual(['0', '0.5M', '1.0M', '1.5M']);
    expect(axisLabels(2_000_000, 3, 'en')).toEqual(['0', '2M', '4M', '6M']);
    expect(axisLabels(25_000, 3, 'en')).toEqual(['0', '25K', '50K', '75K']);
    expect(axisLabels(500_000, 3, 'zh')).toEqual(['0', '50万', '100万', '150万']);
  });
});

describe('RateChart cold start', () => {
  const MINUTE = Date.UTC(2026, 9, 24, 10, 59, 0);
  const rate = (sinceAgoMs: number): TokenRate => ({
    minute: new Date(MINUTE).toISOString(),
    at: new Date(MINUTE + 30_000).toISOString(),
    since: new Date(MINUTE + 30_000 - sinceAgoMs).toISOString(),
    agents: {},
    coverage: { running: 0, counted: 0, agents: {} },
  });
  const chart = (sinceAgoMs: number, from: number, sinceLabel: string | null) =>
    render(
      <RateChart
        rate={rate(sinceAgoMs)}
        values={series(RATE_MINUTES - from)}
        from={from}
        locale="en"
        label="chart"
        ticksX={['−60 min', '−30', 'now']}
        sinceLabel={sinceLabel}
      />,
    ).container;

  it('marks when counting began, says so with room, and draws nothing before it', () => {
    // Counting since 12.5 minutes ago: the first whole minute is 12 buckets back.
    const c = chart(12.5 * MINUTE_MS, RATE_MINUTES - 13, 'counting since 10:46');
    expect(c.querySelector('[data-since] line')).not.toBeNull();
    expect(c.querySelector('[data-since] text')).toHaveTextContent('counting since 10:46');
    const points = c.querySelector('polyline')?.getAttribute('points')?.split(' ') ?? [];
    expect(points).toHaveLength(13);
    // The axis stays 60 minutes: the line starts well right of the plot's left edge.
    expect(Number(points[0]?.split(',')[0])).toBeGreaterThan(250);
    expect(c.querySelector('circle')).toHaveAttribute('r', '2.6');
  });

  it('leaves the label out where there is no room for it left of the rule', () => {
    const c = chart(57 * MINUTE_MS, 3, 'counting since 10:02');
    expect(c.querySelector('[data-since] line')).not.toBeNull();
    expect(c.querySelector('[data-since] text')).toBeNull();
  });

  it('draws no rule once the whole hour is counted', () => {
    const c = chart(120 * MINUTE_MS, 0, null);
    expect(c.querySelector('[data-since]')).toBeNull();
    expect(c.querySelector('polyline')?.getAttribute('points')?.split(' ')).toHaveLength(60);
  });
});
