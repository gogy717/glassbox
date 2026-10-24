/**
 * The weekly receipt as one SVG (D3): the session receipt's paper, ink, rows and foot, with the
 * week's hook in place of the barcode, a 7 × 24 grid of when the agents worked. Two quieter
 * slips: a week with under half an hour of agent time (the way out is the last 7 days), and a
 * week with no sessions.
 */
import type { WeekWindowKind } from '../../../../src/shared/week.js';
import { agentName } from '../../lib/agent-names';
import {
  clock,
  count,
  day,
  durationParts,
  hourOf,
  minuteParts,
  type Parts,
  partsText,
  shortDay,
  underOne,
  weekdayMark,
  weekSerial,
} from './format';
import { categoryLine, clip } from './rows';
import {
  frame,
  INNER,
  LEFT,
  num,
  Pen,
  partsBody,
  type ReceiptOptions,
  type ReceiptSize,
  RIGHT,
  runs,
  text,
  textWidth,
  wrap,
} from './slip';
import type { ReceiptKey } from './strings';
import {
  type GridCell,
  isQuiet,
  longestLine,
  unreportedLine,
  type WeekReceipt,
  weekAge,
} from './week';

/** The last 7 days in brief, for the way out of a quiet or empty week. */
export interface WeekElsewhere {
  sessions: number;
  agentMs: number;
}

/** Grid geometry: 11-unit cells a unit apart, after a 24-unit column of weekday labels. */
const CELL = 11;
const PITCH = 12;
const GRID_X = LEFT + 24;

/** Agent minutes in an hour as ink: none, under 10, under 40, 40 and up (parallel agents pass 60). */
export function inkOf(cell: GridCell): 'future' | 'none' | 'low' | 'mid' | 'high' | 'out' {
  if (cell.state !== 'past') return cell.state;
  const min = cell.ms / 60_000;
  return cell.ms <= 0 ? 'none' : min < 10 ? 'low' : min < 40 ? 'mid' : 'high';
}

/** "5 minutes", "3 hours", "4 days": how far into the week, for the quiet slip. */
export function elapsedWords(ms: number, w: (k: ReceiptKey, p: Record<string, number>) => string) {
  const min = Math.max(1, Math.floor(ms / 60_000));
  if (min < 60) return w('minutesN', { n: min });
  const hours = Math.floor(min / 60);
  return hours < 24 ? w('hoursN', { n: hours }) : w('daysN', { n: Math.floor(hours / 24) });
}

/** The line under the head (and the dialog's title): which window, from when to when. */
export function windowLine(
  kind: WeekWindowKind,
  start: number,
  end: number,
  L: ReceiptOptions['locale'],
  w: (k: ReceiptKey) => string,
) {
  if (kind === '7d') return `${w('last7')} · ${shortDay(start, L)} ${clock(start)} → ${w('now')}`;
  if (new Date(start).toDateString() === new Date(end).toDateString())
    return `${w('thisWeek')} · ${day(start, L)}${L === 'zh' ? '' : ','} ${clock(start)} → ${clock(end)}`;
  const time = L === 'zh' ? ` ${clock(end)}` : ` · ${clock(end)}`;
  return `${w('thisWeek')} · ${shortDay(start, L)} → ${shortDay(end, L)}${time}`;
}

/** The share a CLI's row prints: "76%", or "<1%" for one that did a little (DR4). */
export const shareText = (share: number | '<1') => `${share}%`;

/** What a figure prints when nothing it comes from was timed (G8). */
export const DASH: Parts = [{ digits: '—', unit: '' }];

/** A time as printed, "—" when nothing was timed. */
export const timeParts = (ms: number, L: ReceiptOptions['locale']): Parts =>
  ms > 0 ? durationParts(ms, L) : DASH;

/**
 * A CLI's time as printed: its share of the hero's minutes (or seconds); "<1m" ("<1s") when it
 * worked but its share comes to none, the unit going to the others so the rows still add up
 * (DR12); "—" when it has no time at all.
 */
export function cliParts(
  r: WeekReceipt['byCli'][number],
  unit: WeekReceipt['cliUnit'],
  L: ReceiptOptions['locale'],
): Parts {
  if (r.ms === 0) return DASH;
  if (r.units === 0) return underOne(unit, L);
  return unit === 'min' ? minuteParts(r.units, L) : durationParts(r.units * 1000, L);
}

type Words = (k: ReceiptKey, p?: Record<string, string | number>) => string;

/** The quiet slip's line: how far into the week, how many sessions, and their time if timed. */
export function quietLine(d: WeekReceipt, w: Words, time: (ms: number) => string): string {
  const said = { elapsed: elapsedWords(weekAge(d), (k, q) => w(k, q)), n: d.sessions };
  return d.agentMs > 0 ? w('quiet', { ...said, time: time(d.agentMs) }) : w('quietUntimed', said);
}

/** The way out of a quiet or empty week: the last 7 days, their time left out if there is none. */
export const wayOutLine = (e: WeekElsewhere, w: Words, time: (ms: number) => string) =>
  e.agentMs > 0
    ? w('wayOut', { n: e.sessions, time: time(e.agentMs) })
    : w('wayOutUntimed', { n: e.sessions });

/** The weekly receipt's drawing and its height, in slip units. */
export function drawWeek(
  d: WeekReceipt,
  o: ReceiptOptions,
  elsewhere: WeekElsewhere | null = null,
): { body: string; height: number } {
  const p = new Pen(o);
  const { c, L } = p;
  const w = (key: ReceiptKey, params?: Record<string, string | number>) => p.w(key, params);
  const fits11 = (s: string) => textWidth(s, 11);
  const empty = d.sessions === 0;
  const quiet = isQuiet(d);

  p.head('weeklyHeading');
  p.y = 78;
  const meta = windowLine(d.kind, d.start, d.now, L, w);
  p.push(text(LEFT, p.y, runs(clip(meta, INNER, fits11)), { size: 11, fill: c.soft }));
  if (!empty) {
    p.y += 17;
    const who =
      d.clis.length > 3
        ? `${w('clisN', { n: d.clis.length })} · ${w('projectsN', { n: d.projects })}`
        : d.clis.map(agentName).join(' · ');
    p.push(text(LEFT, p.y, runs(clip(who, INNER, fits11)), { size: 11, fill: c.soft }));
    // The hero: the grid's sum, every agent's working time (parallel agents pass the clock).
    p.y += 37;
    p.hero('agentTime', partsBody(timeParts(d.agentMs, L)));
    // With sub-agents at work, the main agents' own clock too: the session receipts' DURATION.
    if (d.work.subAgents > 0) {
      p.y += 24;
      p.row(w('sessionTime'), timeParts(d.sessionMs, L), { size: 11, fill: c.soft });
      p.y += 16;
    } else p.y += 20;
  } else p.y += 20;
  p.rule();

  // WEEK (or LAST 7 DAYS): the grid, its hour axis, the busiest hour and the share after hours.
  p.y += 18;
  p.label(d.kind === 'week' ? 'week' : 'last7');
  const top = p.y + 10;
  d.grid.forEach((cells, row) => {
    const y = top + row * PITCH;
    const mark = weekdayMark(d.rows[row] ?? d.start, L);
    p.push(text(LEFT, y + 8.5, runs(mark), { size: 9, fill: c.soft }));
    cells.forEach((cell, col) => {
      const x = GRID_X + col * PITCH;
      const ink = empty && cell.state !== 'out' ? 'future' : inkOf(cell);
      if (ink === 'out') return;
      if (ink === 'future')
        p.push(
          `<rect x="${num(x + 0.5)}" y="${num(y + 0.5)}" width="${CELL - 1}" height="${CELL - 1}" fill="none" stroke="${c.ink}" stroke-opacity="0.18" stroke-width="1"/>`,
        );
      else if (ink === 'none')
        p.push(
          `<rect x="${num(x + 4.5)}" y="${num(y + 4.5)}" width="2" height="2" fill="${c.ink}" fill-opacity="0.28"/>`,
        );
      else
        p.push(
          `<rect x="${x}" y="${num(y)}" width="${CELL}" height="${CELL}" fill="${c.ink}"${ink === 'high' ? '' : ` fill-opacity="${ink === 'low' ? 0.25 : 0.6}"`}/>`,
        );
    });
  });
  // The end: a hairline in the gap after the hour the receipt ends in, on its row (R20).
  const cx = GRID_X + (d.cursor.col + 1) * PITCH - 0.5;
  const cy = top + d.cursor.row * PITCH;
  p.push(
    `<line x1="${num(cx)}" y1="${num(cy - 2)}" x2="${num(cx)}" y2="${num(cy + CELL + 2)}" stroke="${c.ink}" stroke-width="1"/>`,
  );
  p.y = top + 7 * PITCH + 9;
  for (const h of [0, 6, 12, 18, 24]) {
    const anchor = h === 0 ? 'start' : h === 24 ? 'end' : 'middle';
    const x = GRID_X + h * PITCH - (h === 24 ? 1 : h === 0 ? 0 : 0.5);
    p.push(text(x, p.y, runs(String(h)), { size: 9, fill: c.soft, anchor }));
  }

  const elsewhereLine = () => {
    if (!elsewhere || elsewhere.sessions === 0 || d.kind !== 'week') return;
    p.y += 10;
    const said = wayOutLine(elsewhere, w, (ms) => partsText(durationParts(ms, L)));
    for (const line of wrap(said, 11.5, INNER, 3)) {
      p.y += 17;
      p.push(text(LEFT, p.y, runs(line), { size: 11.5, fill: c.soft }));
    }
  };
  const close = (measured: boolean) => {
    p.y += 22;
    p.rule();
    p.y += 22;
    p.serial(weekSerial(d.kind, d.start, d.now));
    const height = p.foot(measured, 24);
    return { body: p.out.join(''), height };
  };

  if (empty || quiet) {
    p.y += 14;
    const said = empty
      ? w(d.kind === 'week' ? 'noSessions' : 'noSessions7')
      : quietLine(d, w, (ms) => partsText(durationParts(ms, L)));
    for (const line of wrap(said, 12, INNER, 3)) {
      p.y += 19;
      p.push(text(LEFT, p.y, runs(line), { fill: c.ink }));
    }
    elsewhereLine();
    return close(!empty && d.tokens.measured);
  }

  // The busiest hour and the share after hours, "—" in a week of which nothing was timed.
  p.y += 24;
  const busiest = d.busiest;
  p.row(
    w('busiestHour'),
    busiest
      ? [{ digits: `${hourOf(busiest.at, L)} · `, unit: '' }, ...durationParts(busiest.ms, L)]
      : DASH,
  );
  p.y += 19;
  p.row(
    w('afterHours'),
    d.afterHours !== null ? [{ digits: `${Math.round(d.afterHours * 100)}%`, unit: '' }] : DASH,
  );
  p.y += 20;
  p.rule();

  // WORK: counts in a column as wide as the widest; a line at zero is left out.
  p.y += 18;
  p.label('work');
  const k = d.work;
  const figures = [d.sessions, k.requests, k.toolCalls, k.subAgents, k.failures].map((n) =>
    count(n, L),
  );
  const numRight = LEFT + Math.max(30, ...figures.map((f) => textWidth(f, 12)));
  const workRow = (n: number, key: ReceiptKey, fail = false) => {
    p.y += 19;
    const fill = fail ? c.fail : c.ink;
    p.push(text(numRight, p.y, runs(count(n, L)), { fill, anchor: 'end' }));
    p.push(text(numRight + 8, p.y, runs(w(key, { n })), { fill }));
  };
  workRow(d.sessions, 'sessions');
  if (d.projects > 0) {
    // SVG drops a leading space: the gap is in the position instead.
    const after = numRight + 8 + textWidth(`${w('sessions', { n: d.sessions })} `, 12);
    p.push(
      text(after, p.y, runs(`· ${w('projectsN', { n: d.projects })}`), { size: 11, fill: c.soft }),
    );
  }
  if (k.requests > 0) workRow(k.requests, 'modelCalls');
  if (k.toolCalls > 0) {
    workRow(k.toolCalls, 'toolCalls');
    if (k.categories.length > 0) {
      p.y += 17;
      const room = RIGHT - (numRight + 8);
      const cats = categoryLine(
        k.categories,
        L,
        (line) => textWidth(line, 11) <= room,
        (n) => count(n, L),
      );
      p.push(text(numRight + 8, p.y, runs(cats), { size: 11, fill: c.soft }));
    }
  }
  if (k.subAgents > 0) workRow(k.subAgents, 'subAgents');
  if (k.failures > 0) workRow(k.failures, 'failures', true);
  p.y += 22;
  p.rule();

  // BY CLI: the agent time split by CLI (its rows add up to the hero); only with two or more.
  if (d.byCli.length > 1) {
    p.y += 18;
    p.label('byCli');
    for (const r of d.byCli) {
      p.y += 19;
      p.row(agentName(r.agent), cliParts(r, d.cliUnit, L), {
        valueRight: RIGHT - 42,
        share: r.share === null ? undefined : shareText(r.share),
      });
    }
    p.y += 20;
    p.rule();
  }

  // LONGEST: the session that worked longest by its own clock, named unless names are withheld;
  // "—", naming none, when no session's clock ran.
  p.y += 22;
  p.row(w('longestSession'), d.longest ? timeParts(d.longest.ms, L) : DASH);
  if (d.longest) {
    p.y += 17;
    const line = longestLine(d.longest, o.hideNames, w);
    p.push(text(LEFT, p.y, runs(clip(line, INNER, fits11)), { size: 11, fill: c.soft }));
    p.y += 16;
  } else p.y += 20;
  p.rule();

  // TOKENS, with the sessions that report none named by CLI, on one line whatever their number.
  const note = unreportedLine(d, L, (line) => textWidth(line, 11) <= INNER);
  p.tokens(d.tokens, note ?? undefined);
  p.y += 27;
  p.serial(weekSerial(d.kind, d.start, d.now));
  const height = p.foot(d.tokens.measured, 24);
  return { body: p.out.join(''), height };
}

/** The weekly receipt as an image at `size`, in slip units. */
export function weekSvg(
  d: WeekReceipt,
  o: ReceiptOptions,
  size: ReceiptSize,
  elsewhere: WeekElsewhere | null = null,
): { svg: string; width: number; height: number } {
  return frame(drawWeek(d, o, elsewhere), o, size);
}

/**
 * While the week is read: the head, the window, a progress bar and how far it got; when it could
 * not be read, the head, the window and why, without a bar.
 */
export function stubSvg(
  o: ReceiptOptions,
  line: string,
  state: { done: number; total: number } | { failed: string },
  size: ReceiptSize,
): { svg: string; width: number; height: number } {
  const p = new Pen(o);
  const { c } = p;
  p.head('weeklyHeading');
  p.y = 78;
  p.push(text(LEFT, p.y, runs(line), { size: 11, fill: c.soft }));
  if ('failed' in state) {
    for (const said of wrap(p.w('weekFailed', { msg: state.failed }), 11, INNER, 3)) {
      p.y += 19;
      p.push(text(LEFT, p.y, runs(said), { size: 11, fill: c.fail }));
    }
  } else {
    p.y += 12;
    const share = state.total > 0 ? Math.min(1, state.done / state.total) : 0;
    p.push(
      `<rect x="${LEFT}" y="${num(p.y)}" width="${INNER}" height="2" fill="${c.faint}"/>`,
      `<rect x="${LEFT}" y="${num(p.y)}" width="${num(INNER * share)}" height="2" fill="${c.ink}"/>`,
    );
    p.y += 21;
    p.push(text(LEFT, p.y, runs(p.w('reading', state)), { size: 11, fill: c.soft }));
  }
  return frame({ body: p.out.join(''), height: Math.ceil(p.y + 24) }, o, size);
}
