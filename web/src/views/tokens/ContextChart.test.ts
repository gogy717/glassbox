import { describe, expect, it } from 'vitest';
import { axisLabels, LABEL_GAP, labelX } from './ContextChart';

describe('axisLabels', () => {
  it('drops the regular label that would run into the last one ("#145#156")', () => {
    const labels = axisLabels(156, 700);
    expect(labels.at(-1)).toBe(155);
    expect(labels).not.toContain(144);
  });

  it.each([
    [156, 700],
    [156, 1100],
    [29, 400],
    [10, 900],
    [500, 1200],
    [3, 120],
  ])('keeps %i points labelled at least a label apart at %ipx, first and last included', (n, w) => {
    const labels = axisLabels(n, w);
    expect(labels[0]).toBe(n > 1 && labelX(n - 1, n, w) - labelX(0, n, w) < LABEL_GAP ? n - 1 : 0);
    expect(labels.at(-1)).toBe(n - 1);
    for (let i = 1; i < labels.length; i++) {
      const gap = labelX(labels[i] as number, n, w) - labelX(labels[i - 1] as number, n, w);
      expect(gap).toBeGreaterThanOrEqual(LABEL_GAP);
    }
  });

  it('labels a single point, and nothing without points', () => {
    expect(axisLabels(1, 600)).toEqual([0]);
    expect(axisLabels(0, 600)).toEqual([]);
  });
});
