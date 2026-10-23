import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoSessions } from '../../../src/core/fixtures/demo.js';
import type { SessionSummary } from '../../../src/core/model.js';
import { I18nContext, makeI18n } from '../i18n';
import { DEMO_NOW } from '../test/demo';
import { SessionRow } from './SessionRow';

const [running, idle] = createDemoSessions(DEMO_NOW) as [SessionSummary, SessionSummary];

function renderRow(
  session: SessionSummary,
  selected = false,
  onSelect = vi.fn(),
  locale: 'en' | 'zh' = 'en',
) {
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <SessionRow
        session={session}
        selected={selected}
        now={DEMO_NOW.getTime()}
        onSelect={onSelect}
      />
    </I18nContext.Provider>,
  );
  return screen.getByRole('button');
}

describe('SessionRow', () => {
  it('reads title, then state · short age · tokens, with the agent tag last', () => {
    const row = renderRow(running);
    expect(row).toHaveAttribute('data-density', 'compact');
    const meta = row.lastElementChild as HTMLElement;
    const parts = [...meta.children].map((c) => c.textContent?.trim());
    expect(parts[0]).toBe('Running');
    expect(parts[1]).toMatch(/^· (now|\d+s ago) · 1\.9M1\.9M tokens$/);
    expect(parts.at(-1)).toBe('Claude Code');
    // The figure is mono and silent; the spoken text says what it counts.
    expect(meta.querySelector('.figure')).toHaveAttribute('aria-hidden', 'true');
    expect(meta.querySelector('.visually-hidden')).toHaveTextContent('1.9M tokens');
  });

  it('marks the open session and opens the one clicked', () => {
    const onSelect = vi.fn();
    const row = renderRow(idle, true, onSelect);
    expect(row).toHaveAttribute('aria-current', 'true');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(idle.id);
  });

  it('shows short ages in Chinese too', () => {
    const row = renderRow(
      { ...idle, updatedAt: new Date(DEMO_NOW.getTime() - 2 * 3_600_000).toISOString() },
      false,
      vi.fn(),
      'zh',
    );
    expect(row).toHaveTextContent('2小时前');
  });
});
