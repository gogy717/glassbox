import {
  type KeyboardEvent,
  memo,
  type Ref,
  type SyntheticEvent,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { UiCjk } from '../../components/CompactFigure';
import { weekdayMark } from '../../components/receipt/format';
import type { WeekReceipt } from '../../components/receipt/week';
import { inkOf } from '../../components/receipt/weekFigures';
import type { Locale } from '../../i18n';
import type { CellLabel } from './statsData';
import css from './WeekGrid.module.css';

/** A cell of the 7 × 24 grid: its row (a day) and its column (an hour). */
export interface Cell {
  row: number;
  col: number;
}

interface Props {
  /** The receipt whose grid is drawn: the window's, or one CLI's or project's alone (isolate). */
  drawn: WeekReceipt;
  /** What each cell says, worked out once for the week drawn: its tip and its label. */
  labels: CellLabel[][];
  locale: Locale;
  label: string;
  selected: Cell | null;
  onSelect(cell: Cell): void;
  /** The week as read: a new read sends the tab stop back to the selected hour. */
  week: object;
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

type Step = (c: Cell) => Cell;
const right: Step = (c) => ({ row: c.row, col: c.col + 1 });
const left: Step = (c) => ({ row: c.row, col: c.col - 1 });
/** Where a key starts looking, and which way it goes on past an hour the window lacks. */
const KEYS: Record<string, { from: Step; on: Step }> = {
  ArrowRight: { from: right, on: right },
  ArrowLeft: { from: left, on: left },
  ArrowDown: {
    from: (c) => ({ row: c.row + 1, col: c.col }),
    on: (c) => ({ row: c.row + 1, col: c.col }),
  },
  ArrowUp: {
    from: (c) => ({ row: c.row - 1, col: c.col }),
    on: (c) => ({ row: c.row - 1, col: c.col }),
  },
  Home: { from: (c) => ({ row: c.row, col: 0 }), on: right },
  End: { from: (c) => ({ row: c.row, col: 23 }), on: left },
};
const inside = (c: Cell) => c.row >= 0 && c.row < 7 && c.col >= 0 && c.col < 24;

/** The cell a grid event came from, by its `data-cell`; null for the gaps between. */
const cellOf = (e: SyntheticEvent): Cell | null => {
  const at = (e.target as HTMLElement).dataset?.cell?.split(':').map(Number);
  return at?.length === 2 ? { row: at[0] as number, col: at[1] as number } : null;
};

/**
 * When the agents worked (D4): the weekly receipt's 7 × 24 grid, its four inks, the hours to come
 * outlined and the now cursor; a table of hours, each a button. One tab stop: the arrows move it
 * over the hours the window has, Home and End to a row's ends; a click, Enter or Space shows that
 * hour in the card. A cell's tip (hover or focus) is its label too. Drawn once a week: a hover
 * moves only the tip, which keeps its own state (I1).
 */
export const WeekGrid = memo(function WeekGrid({
  drawn,
  labels,
  locale,
  label,
  selected,
  onSelect,
  week,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const tip = useRef<TipHandle>(null);
  const [moved, setMoved] = useState<{ cell: Cell; week: object } | null>(null);
  const has = (c: Cell | null): c is Cell =>
    !!c && inside(c) && drawn.grid[c.row]?.[c.col]?.state !== 'out';
  // The stop: where the keys or a click left it in this read of the week, else the hour the card
  // shows, else the first hour the window has.
  const stop =
    (moved?.week === week && has(moved.cell) && moved.cell) ||
    (has(selected) && selected) ||
    drawn.grid.flatMap((cells, row) => cells.map((_, col) => ({ row, col }))).find(has) ||
    null;
  const move = (cell: Cell) => setMoved({ cell, week });
  const showTip = (e: SyntheticEvent, c: Cell) => {
    const box = ref.current?.getBoundingClientRect();
    const r = (e.target as HTMLElement).getBoundingClientRect();
    if (!box || !labels[c.row]?.[c.col]) return;
    // From the right half the tip opens leftwards, so it stays over the grid.
    const toLeft = c.col >= 12;
    tip.current?.show(c, (toLeft ? r.right : r.left) - box.left, r.top - box.top, toLeft);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const at = cellOf(e);
    const key = KEYS[e.key];
    if (!at || !key) return;
    e.preventDefault();
    let next = key.from(at);
    while (inside(next) && !has(next)) next = key.on(next);
    if (!has(next)) return;
    move(next);
    ref.current?.querySelector<HTMLElement>(`[data-cell="${next.row}:${next.col}"]`)?.focus();
  };
  // A new read of the week: the old read's tip goes with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hides it on each new read
  useEffect(() => tip.current?.hide(), [week]);
  return (
    <div className={css.wrap} ref={ref}>
      {/* The hours' buttons' events, met once here rather than on each of the 168. */}
      <table
        className={css.grid}
        aria-label={label}
        onClick={(e) => {
          const at = cellOf(e);
          if (!at) return;
          move(at);
          onSelect(at);
        }}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          const at = cellOf(e);
          if (at) showTip(e, at);
        }}
        onBlur={() => tip.current?.hide()}
        onPointerOver={(e) => {
          const at = cellOf(e);
          if (at) showTip(e, at);
          else tip.current?.hide();
        }}
        onPointerLeave={() => tip.current?.hide()}
      >
        <tbody>
          {drawn.grid.map((cells, row) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the seven days of the window, in order
            <tr key={row}>
              <th scope="row" className={`${css.day} figure`}>
                <UiCjk text={weekdayMark(drawn.rows[row] ?? 0, locale)} />
              </th>
              {cells.map((cell, col) => {
                const words = labels[row]?.[col];
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
                      aria-current={same(selected, { row, col }) || undefined}
                      aria-label={words ? `${words.title} · ${words.line}` : undefined}
                      tabIndex={same(stop, { row, col }) ? 0 : -1}
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
      <GridTip ref={tip} labels={labels} />
    </div>
  );
});

interface TipHandle {
  show(cell: Cell, x: number, y: number, toLeft: boolean): void;
  hide(): void;
}

/**
 * A cell's tip, with its own state: a hover draws the tip again and nothing else. It holds the
 * cell, not its words, and reads them from the labels drawn: a grid drawn anew under it (a pin let
 * go) changes what it says.
 */
function GridTip({ ref, labels }: { ref: Ref<TipHandle>; labels: CellLabel[][] }) {
  const [tip, setTip] = useState<{ cell: Cell; x: number; y: number; toLeft: boolean } | null>(
    null,
  );
  useImperativeHandle(
    ref,
    () => ({
      show: (cell, x, y, toLeft) => setTip({ cell, x, y, toLeft }),
      hide: () => setTip(null),
    }),
    [],
  );
  const words = tip && labels[tip.cell.row]?.[tip.cell.col];
  if (!tip || !words) return null;
  return (
    <div
      className={css.tip}
      aria-hidden="true"
      data-right={tip.toLeft || undefined}
      style={{ left: tip.x, top: tip.y }}
    >
      <strong>{words.title}</strong>
      <span>{words.line}</span>
    </div>
  );
}
