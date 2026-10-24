import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CompactFigure } from './CompactFigure';

const parts = (value: string) => {
  const { container } = render(
    <span data-testid="x">
      <CompactFigure value={value} />
    </span>,
  );
  const figure = container.querySelector('.figure');
  return { figure: figure?.textContent, all: container.textContent };
};

describe('CompactFigure', () => {
  it.each([
    ['1.9M', '1.9M'],
    ['412K', '412K'],
    ['264.8万', '264.8'],
    ['1.2亿', '1.2'],
    ['—', '—'],
  ])('sets %j as the figure %j, with a CJK unit after it in the UI face', (value, figure) => {
    const got = parts(value);
    expect(got.figure).toBe(figure);
    expect(got.all).toBe(value);
  });
});
