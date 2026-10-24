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
  more: { density?: 'compact' | 'card'; failure?: string | null } = {},
) {
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <SessionRow
        session={session}
        selected={selected}
        now={DEMO_NOW.getTime()}
        onSelect={onSelect}
        {...more}
      />
    </I18nContext.Provider>,
  );
  return screen.getByRole('button');
}

const since = (s: number) => new Date(DEMO_NOW.getTime() - s * 1000).toISOString();
const reading: SessionSummary = {
  ...running,
  activity: { kind: 'tool', tool: 'Read', target: 'tokens.css', agentId: 'main', since: since(4) },
};

describe('SessionRow', () => {
  // I3: zh compact counts end in 万 or 亿; only the digits are a figure (CJK never in mono).
  it('sets only the digits of a Chinese token count in the mono face', () => {
    const row = renderRow(running, false, vi.fn(), 'zh');
    const figures = [...row.querySelectorAll('.figure')].map((f) => f.textContent ?? '');
    expect(figures.length).toBeGreaterThan(0);
    for (const f of figures) expect(f).not.toMatch(/[\u3000-\u9fff]/);
    expect(row).toHaveTextContent(/[\d.]+万/);
  });

  it('reads title, then state · short age · tokens, with the agent tag last', () => {
    const row = renderRow(running);
    expect(row).toHaveAttribute('data-density', 'compact');
    const meta = row.lastElementChild as HTMLElement;
    const parts = [...meta.children].map((c) => c.textContent?.trim());
    expect(parts[0]).toBe('Running');
    // The age as formatRelative words it ("now", "7 seconds ago", or "7 s ago").
    expect(parts[1]).toMatch(/^· (now|\d+\s?s(econds?)? ago) · 1\.9M1\.9M tokens$/);
    expect(parts.at(-1)).toBe('Claude Code');
    // The figure is mono and silent; the spoken text says what it counts.
    expect(meta.querySelector('.figure')?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(meta.querySelector('.visually-hidden')).toHaveTextContent('1.9M tokens');
  });

  it('marks the open session and opens the one clicked', () => {
    const onSelect = vi.fn();
    const row = renderRow(idle, true, onSelect);
    expect(row).toHaveAttribute('aria-current', 'true');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(idle.id);
  });

  it('says what a running session does in place of its state and age', () => {
    const meta = renderRow(reading).lastElementChild as HTMLElement;
    expect(meta.firstElementChild).toHaveTextContent(/^Reading tokens\.css$/);
    expect(meta).not.toHaveTextContent(/ago|now/);
    expect(meta.querySelector('.visually-hidden')).toHaveTextContent('1.9M tokens');
  });

  it('says a failed run failed, then its age', () => {
    const meta = renderRow(idle, false, vi.fn(), 'en', { failure: 'missing file' })
      .lastElementChild as HTMLElement;
    expect(meta.firstElementChild).toHaveTextContent(/^Failed$/);
    expect(meta.children[1]).toHaveTextContent(/^· /);
  });

  describe('at card density', () => {
    it('reads tag, title and age, then the activity with its clock and the tokens', () => {
      vi.useFakeTimers();
      vi.setSystemTime(DEMO_NOW);
      try {
        const row = renderRow(reading, false, vi.fn(), 'en', { density: 'card' });
        expect(row).toHaveAttribute('data-density', 'card');
        const [head, meta] = [...row.children] as HTMLElement[];
        expect([...(head?.children ?? [])].map((c) => c.textContent)).toEqual([
          'Claude Code',
          'Live viewer research (demo)',
          expect.stringMatching(/now|ago/),
        ]);
        expect(meta).toHaveTextContent('Reading tokens.css · 0:04 · 1.9M tokens');
        // The figures are mono: the clock and the count, not the words around them.
        expect([...(meta?.querySelectorAll('.figure') ?? [])].map((f) => f.textContent)).toEqual([
          '0:04',
          '1.9M',
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives a failure its reason, and leaves out tokens it does not know', () => {
      const row = renderRow(idle, false, vi.fn(), 'en', {
        density: 'card',
        failure: 'missing file',
      });
      expect(row.lastElementChild).toHaveTextContent(/^Failed · missing file$/);
    });

    it('sets only the digits of a Chinese count in the mono face', () => {
      const row = renderRow(running, false, vi.fn(), 'zh', { density: 'card' });
      expect(row.lastElementChild).toHaveTextContent(/[\d.]+万 token$/);
      for (const f of row.querySelectorAll('.figure')) expect(f.textContent).not.toMatch(/万/);
    });
  });

  it('words its age in Chinese too', () => {
    const row = renderRow(
      { ...idle, updatedAt: new Date(DEMO_NOW.getTime() - 2 * 3_600_000).toISOString() },
      false,
      vi.fn(),
      'zh',
    );
    expect(row).toHaveTextContent('2小时前');
  });
});
