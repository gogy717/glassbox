import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WeekResult, WeekSession } from '../../../../src/shared/week.js';
import { I18nContext, type Locale, makeI18n } from '../../i18n';
import { demoWeek } from '../../test/week';
import { HourCard } from './StatsCards';
import { busiestCell, indexHours, statsWeek } from './statsData';
import type { Cell } from './WeekGrid';

/**
 * The demo's week with its busiest session's hours worked by eleven sessions, each a little
 * less than the one before: an hour of eleven sessions, Session 1 the longest.
 */
function crowdedWeek() {
  const base = demoWeek('week');
  const model = base.sessions[0] as WeekSession;
  const sessions = Array.from({ length: 11 }, (_, k) => ({
    ...model,
    id: `claude-code:crowd-${k + 1}`,
    title: `Session ${k + 1}`,
    hours: model.hours.map((ms) => (ms * (11 - k)) / 11),
  }));
  const result: WeekResult = { ...base, sessions };
  return statsWeek(result, false);
}

const crowded = crowdedWeek();
const busiest = busiestCell(crowded) as Cell;

function hourCard(
  cell: Cell | null,
  { locale = 'en', listed = new Set<string>(), w = crowded } = {} as {
    locale?: Locale;
    listed?: Set<string>;
    w?: typeof crowded;
  },
) {
  return (
    <I18nContext.Provider value={makeI18n(locale)}>
      <HourCard
        w={w}
        index={indexHours(w)}
        kind="week"
        cell={cell}
        listed={listed}
        locale={locale}
        empty={false}
        elsewhere={null}
        onElsewhere={vi.fn()}
      />
    </I18nContext.Provider>
  );
}

const titles = () =>
  within(screen.getByRole('list'))
    .getAllByRole('listitem')
    .map((li) => li.firstElementChild?.firstElementChild?.textContent);

describe('the hour card', () => {
  it('lists the hour’s eight longest sessions, then “N more”, which shows the rest', () => {
    const listed = new Set(crowded.result.sessions.map((s) => s.id));
    render(hourCard(busiest, { listed }));
    expect(titles()).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Session ${n}`));
    fireEvent.click(screen.getByRole('button', { name: '3 more' }));
    expect(titles()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `Session ${n}`));
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
    // Focus moves on to the first of the rest, as the sidebar's "N more" does.
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Session 9' }));
  });

  it('moves focus to the first of the rest when it is not a link', () => {
    render(hourCard(busiest));
    fireEvent.click(screen.getByRole('button', { name: '3 more' }));
    expect(document.activeElement).toHaveTextContent(/^Session 9/);
    expect(document.activeElement?.tagName).toBe('LI');
  });

  it('folds again when another hour is picked', () => {
    const { rerender } = render(hourCard(busiest));
    fireEvent.click(screen.getByRole('button', { name: '3 more' }));
    rerender(hourCard({ row: 0, col: 0 }));
    rerender(hourCard(busiest));
    expect(titles()).toHaveLength(8);
    expect(screen.getByRole('button', { name: '3 more' })).toBeInTheDocument();
  });

  it('says it in Chinese', () => {
    render(hourCard(busiest, { locale: 'zh' }));
    expect(screen.getByRole('button', { name: '还有 3 个' })).toBeInTheDocument();
  });

  it('has no “more” for an hour of eight or fewer', () => {
    const w = statsWeek(demoWeek('week'), false);
    const cell = busiestCell(w) as Cell;
    render(hourCard(cell, { w }));
    expect(titles().length).toBeGreaterThan(0);
    expect(titles().length).toBeLessThanOrEqual(8);
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
  });
});
