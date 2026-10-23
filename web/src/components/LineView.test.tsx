import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFakeLayout } from '../test/layout';
import { LineView } from './LineView';

describe('LineView', () => {
  useFakeLayout();

  it('soft-wraps a multi-megabyte single line into fixed-width rows', () => {
    const { container } = render(<LineView text={'x'.repeat(2_000_000)} />);
    const rows = [...container.querySelectorAll('[data-line]')];
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThan(500);
    for (const r of rows) expect(r.textContent?.length ?? 0).toBeLessThanOrEqual(240);
    expect(rows[1]).toHaveAttribute('data-continued');
  });

  it('keeps short lines as they are', () => {
    const { container } = render(<LineView text={'{\n  "a": 1\n}'} />);
    const rows = [...container.querySelectorAll('[data-line]')].map((r) => r.textContent);
    expect(rows).toEqual(['{', '  "a": 1', '}']);
  });
});
