import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeI18n } from '../../i18n';
import type { ContextPoint } from '../../lib/token-stats';
import { ContextChart } from './ContextChart';

const points = (...contexts: number[]): ContextPoint[] =>
  contexts.map((context, i) => ({
    requestId: `q${i + 1}`,
    turn: 1,
    call: i + 1,
    at: null,
    context,
    output: 500,
    compacted: false,
  }));

function chart(p: ContextPoint[], size: number | null, locale: 'en' | 'zh' = 'en') {
  const { container } = render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <ContextChart agent="Main" points={p} windowTokens={size} onPick={vi.fn()} />
    </I18nContext.Provider>,
  );
  return container;
}

afterEach(cleanup);

describe('ContextChart window', () => {
  it('draws the model’s window as a line once the context is half way there, labelled once', () => {
    const box = chart(points(60_000, 120_000, 171_000), 200_000);
    expect(box.querySelectorAll('[data-window]')).toHaveLength(1);
    const labels = [...box.querySelectorAll('svg text')].filter((t) =>
      t.textContent?.includes('window'),
    );
    expect(labels.map((t) => t.textContent)).toEqual(['200K window']);
    // The scale reaches the window: its top gridline is the window.
    const ticks = [...box.querySelectorAll('svg text')].map((t) => t.textContent);
    expect(ticks).toContain('200K');
  });

  it('only names a window far above the curve, so the curve keeps its height', () => {
    const box = chart(points(30_000, 60_000), 1_000_000);
    expect(box.querySelector('[data-window]')).toBeNull();
    expect(box.querySelector('svg')?.textContent).not.toMatch(/window/);
    expect(box.textContent).toContain('1M window');
  });

  it('draws nothing for a window not known, and speaks Chinese', () => {
    const none = chart(points(60_000, 171_000), null);
    expect(none.querySelector('[data-window]')).toBeNull();
    expect(none.textContent).not.toMatch(/window/);
    cleanup();
    expect(chart(points(60_000, 171_000), 200_000, 'zh').textContent).toContain('窗口 20万');
  });
});
