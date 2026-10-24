import { type KeyboardEvent, useRef, useState } from 'react';
import { UiCjk } from '../../components/CompactFigure';
import { weekdayMark } from '../../components/receipt/format';
import type { WeekReceipt } from '../../components/receipt/week';
import { inkOf } from '../../components/receipt/weekSvg';
import type { Locale } from '../../i18n';
import css from './WeekGrid.module.css';

/** A cell of the 7 × 24 grid: its row (a day) and its column (an hour). */
export interface Cell {
  row: number;
  col: number;
}

interface Props {
  /** The receipt whose grid is drawn: the window's, or one CLI's or project's alone (isolate). */
  drawn: WeekReceipt;
  locale: Locale;
  label: string;
  selected: Cell | null;
  onSelect(cell: Cell): void;
  /** What a cell says on hover and focus, and to a screen reader: its hour, then its minutes. */
  describe(cell: Cell): { title: string; line: string };
}

/** The hour marks under the grid: where each starts, in columns, and how many it spans. */
const TICKS = [
  { h: 0, span: 6 },
  { h: 6, span: 6 },
  { h: 12, span: 6 },
  { h: 18, span: 5 },
  { h: 24, span: 1 },
];
const same = (a: Cell | null, b: Cell) => a?.row === b.row && a?.col === b.col;

const step: Record<string, (c: Cell) => Cell> = {
  ArrowRight: (c) => ({ row: c.row, col: Math.min(23, c.col + 1) }),
  ArrowLeft: (c) => ({ row: c.row, col: Math.max(0, c.col - 1) }),
  ArrowDown: (c) => ({ row: Math.min(6, c.row + 1), col: c.col }),
  ArrowUp: (c) => ({ row: Math.max(0, c.row - 1), col: c.col }),
  Home: (c) => ({ row: c.row, col: 0 }),
  End: (c) => ({ row: c.row, col: 23 }),
};

/**
 * When the agents worked (D4): the weekly receipt's 7 × 24 grid, its four inks, the hours to come
 * outlined and the now cursor; a table of hours, each a button. One tab stop: the arrows, Home
 * and End move it; a click, Enter or Space shows that hour in the card. A cell's tip (hover or
 * focus) is its label too.
 */
export function WeekGrid({ drawn, locale, label, selected, onSelect, describe }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [stop, setStop] = useState<Cell>(selected ?? { row: 0, col: 0 });
  const [tip, setTip] = useState<{ cell: Cell; x: number; y: number; right: boolean } | null>(null);
  const show = (el: HTMLElement, cell: Cell) => {
    const box = ref.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!box) return;
    // From the right half the tip opens leftwards, so it stays over the grid.
    const right = cell.col >= 12;
    setTip({ cell, right, x: (right ? r.right : r.left) - box.left, y: r.top - box.top });
  };
  const onKeyDown = (e: KeyboardEvent, at: Cell) => {
    const move = step[e.key];
    if (!move) return;
    e.preventDefault();
    const next = move(at);
    setStop(next);
    ref.current?.querySelector<HTMLElement>(`[data-cell="${next.row}:${next.col}"]`)?.focus();
  };
  const shown = tip && describe(tip.cell);
  return (
    <div className={css.wrap} ref={ref}>
      <table className={css.grid} aria-label={label}>
        <tbody>
          {drawn.grid.map((cells, row) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the seven days of the window, in order
            <tr key={row}>
              <th scope="row" className={`${css.day} figure`}>
                <UiCjk text={weekdayMark(drawn.rows[row] ?? 0, locale)} />
              </th>
              {cells.map((cell, col) => {
                const at = { row, col };
                const d = describe(at);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the 24 hours of a day, in order
                  <td key={col}>
                    <button
                      type="button"
                      className={css.cell}
                      data-cell={`${row}:${col}`}
                      data-ink={inkOf(cell)}
                      data-cursor={
                        (drawn.cursor.row === row && drawn.cursor.col === col) || undefined
                      }
                      aria-current={same(selected, at) || undefined}
                      aria-label={`${d.title} · ${d.line}`}
                      tabIndex={same(stop, at) ? 0 : -1}
                      onClick={() => {
                        setStop(at);
                        onSelect(at);
                      }}
                      onKeyDown={(e) => onKeyDown(e, at)}
                      onFocus={(e) => {
                        setStop(at);
                        show(e.currentTarget, at);
                      }}
                      onBlur={() => setTip(null)}
                      onPointerEnter={(e) => show(e.currentTarget, at)}
                      onPointerLeave={() => setTip(null)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot aria-hidden="true">
          <tr>
            <td />
            {TICKS.map((x) => (
              <td
                key={x.h}
                colSpan={x.span}
                className={`${css.tick} figure`}
                data-end={x.h === 24 || undefined}
              >
                {x.h}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
      {tip && shown && (
        <div
          className={css.tip}
          aria-hidden="true"
          data-right={tip.right || undefined}
          style={{ left: tip.x, top: tip.y }}
        >
          <strong>{shown.title}</strong>
          <span>{shown.line}</span>
        </div>
      )}
    </div>
  );
}
