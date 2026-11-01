import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DASH } from '../../lib/format';
import { ActivityStrip, Ring, TokenBars } from './Gauges';

describe('Ring', () => {
  it('prints the share rounded down inside and carries its tone', () => {
    const { container } = render(<Ring pct={96.97} tone="ok" />);
    const svg = container.querySelector('svg');
    expect(svg?.textContent).toBe('96%');
    expect(svg).toHaveAttribute('data-tone', 'ok');
    expect(svg).toHaveAttribute('data-pct', '96');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    // The arc is the share of the circumference, from the top.
    const c = 2 * Math.PI * 15;
    const arc = container.querySelector('[data-arc]');
    expect(arc?.getAttribute('stroke-dasharray')).toBe(`${(c * 96.97) / 100} ${c}`);
  });
});

describe('ActivityStrip', () => {
  it('draws a bar per call, a triangle per turn and a tick per tool at their x', () => {
    const strip = {
      span: { start: 0, end: 100 },
      turns: [{ x: 0 }, { x: 0.5 }],
      calls: [
        { x: 0.5, h: 1, hollow: false },
        { x: 1, h: 0, hollow: true },
      ],
      tools: [{ x: 0.25 }],
    };
    const { container } = render(<ActivityStrip strip={strip} width={200} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '200');
    expect(svg).toHaveAttribute('viewBox', '0 0 200 30');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelectorAll('[data-turn]')).toHaveLength(2);
    const calls = container.querySelectorAll('[data-call]');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveAttribute('height', '16');
    expect(calls[0]).toHaveAttribute('y', '6');
    expect(calls[1]).toHaveAttribute('height', '3');
    expect(calls[1]).toHaveAttribute('data-call', 'hollow');
    expect(container.querySelectorAll('[data-tool]')).toHaveLength(1);
    // x runs from 4 to width − 4: the second turn's triangle is centred at 100.
    const second = container.querySelectorAll('[data-turn]')[1];
    expect(second?.getAttribute('d')).toBe('M96.5 0 L103.5 0 L100 6 Z');
    expect(container.querySelector('[data-base]')).toHaveAttribute('y1', '22.5');
  });

  it('draws the baseline alone before any turn', () => {
    const { container } = render(
      <ActivityStrip strip={{ span: null, turns: [], calls: [], tools: [] }} width={150} />,
    );
    expect(container.querySelector('[data-base]')).not.toBeNull();
    expect(container.querySelectorAll('[data-call], [data-turn], [data-tool]')).toHaveLength(0);
  });
});

describe('TokenBars', () => {
  it('sets the cached and thinking shares as widths and prints compact totals', () => {
    const { container } = render(
      <TokenBars
        input={23920652}
        cached={23155000}
        output={135439}
        thinking={47039}
        measured
        intl="en"
        width={100}
      />,
    );
    const inRow = container.querySelector('[data-bar="in"]') as HTMLElement;
    const outRow = container.querySelector('[data-bar="out"]') as HTMLElement;
    expect(inRow.querySelector<HTMLElement>('[data-part="cached"]')?.style.width).toBe('96.8%');
    expect(outRow.querySelector<HTMLElement>('[data-part="thinking"]')?.style.width).toBe('34.7%');
    expect(inRow.querySelector<HTMLElement>('[data-track]')?.style.width).toBe('100px');
    expect(inRow.querySelector('[data-total]')?.textContent).toBe('23.9M');
    expect(inRow.querySelector('[data-total]')).toHaveAttribute('title', '23,920,652');
    expect(outRow.querySelector('[data-total]')?.textContent).toBe('135K');
    expect(outRow.querySelector('[data-total]')).toHaveAttribute('title', '135,439 (47,039)');
  });

  it('shows dashes and empty tracks before usage', () => {
    const { container } = render(
      <TokenBars
        input={0}
        cached={0}
        output={0}
        thinking={0}
        measured={false}
        intl="en"
        width={80}
      />,
    );
    for (const total of container.querySelectorAll('[data-total]'))
      expect(total.textContent).toBe(DASH);
    expect(container.querySelectorAll('[data-part]')).toHaveLength(0);
    expect(container.querySelector<HTMLElement>('[data-track]')?.style.width).toBe('80px');
  });
});
