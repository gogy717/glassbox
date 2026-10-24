/**
 * The weekly receipt as one SVG (D3): the session receipt's paper, ink, rows and foot, with the
 * week's hook in place of the barcode, a 7 × 24 grid of when the agents worked. Two quieter
 * slips: a week not a day old (the way out is the last 7 days), and a week with no sessions.
 */
import { agentName } from '../../lib/agent-names';
import {
  clock,
  count,
  day,
  durationParts,
  hourOf,
  type Parts,
  partsText,
  shortDay,
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
import { type GridCell, QUIET_MS, type WeekReceipt, weekAge } from './week';

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

/** "Five minutes into the week": how far in, in words the quiet slip can use. */
export function elapsedWords(ms: number, w: (k: ReceiptKey, p: Record<string, number>) => string) {
  const min = Math.max(1, Math.floor(ms / 60_000));
  return min < 60 ? w('minutesN', { n: min }) : w('hoursN', { n: Math.floor(min / 60) });
}

/** The line under the head: which window, from when to when. */
export function windowLine(
  d: WeekReceipt,
  L: ReceiptOptions['locale'],
  w: (k: ReceiptKey) => string,
) {
  if (d.kind === '7d')
    return `${w('last7')} · ${shortDay(d.start, L)} ${clock(d.start)} → ${w('now')}`;
  if (new Date(d.start).toDateString() === new Date(d.now).toDateString())
    return `${w('thisWeek')} · ${day(d.start, L)}${L === 'zh' ? '' : ','} ${clock(d.start)} → ${clock(d.now)}`;
  const time = L === 'zh' ? ` ${clock(d.now)}` : ` · ${clock(d.now)}`;
  return `${w('thisWeek')} · ${shortDay(d.start, L)} → ${shortDay(d.now, L)}${time}`;
}

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
  const quiet = !empty && d.kind === 'week' && weekAge(d) < QUIET_MS;

  p.head('weeklyHeading');
  p.y = 78;
  p.push(
    text(LEFT, p.y, runs(clip(windowLine(d, L, w), INNER, fits11)), { size: 11, fill: c.soft }),
  );
  if (!empty) {
    p.y += 17;
    const who =
      d.clis.length > 3
        ? `${w('clisN', { n: d.clis.length })} · ${w('projectsN', { n: d.projects })}`
        : d.clis.map(agentName).join(' · ');
    p.push(text(LEFT, p.y, runs(clip(who, INNER, fits11)), { size: 11, fill: c.soft }));
    // The hero: every session's active time, added up (parallel agents pass the wall clock).
    p.y += 37;
    p.hero('agentTime', partsBody(durationParts(d.agentMs, L)));
  }
  p.y += 20;
  p.rule();

  // WEEK: the grid, its hour axis, the busiest hour and the share after hours.
  p.y += 18;
  p.label('week');
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
  // Now: a hairline in the gap after the current hour, on today's row (R20).
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
    const time = partsText(durationParts(elsewhere.agentMs, L));
    for (const line of wrap(w('wayOut', { n: elsewhere.sessions, time }), 11.5, INNER, 3)) {
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
      : w('quiet', {
          elapsed: elapsedWords(weekAge(d), (k, q) => w(k, q)),
          n: d.sessions,
        });
    for (const line of wrap(said, 12, INNER, 3)) {
      p.y += 19;
      p.push(text(LEFT, p.y, runs(line), { fill: c.ink }));
    }
    elsewhereLine();
    return close(!empty && d.tokens.measured);
  }

  if (d.busiest) {
    p.y += 24;
    const at: Parts = [{ digits: `${hourOf(d.busiest.at, L)} · `, unit: '' }];
    p.row(w('busiestHour'), [...at, ...durationParts(d.busiest.ms, L)]);
  }
  if (d.afterHours !== null) {
    p.y += 19;
    p.row(w('afterHours'), [{ digits: `${Math.round(d.afterHours * 100)}%`, unit: '' }]);
  }
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

  // BY CLI: only when more than one CLI worked (the meta line names a lone one).
  if (d.byCli.length > 1) {
    p.y += 18;
    p.label('byCli');
    for (const r of d.byCli) {
      p.y += 19;
      p.row(agentName(r.agent), durationParts(r.ms, L), {
        valueRight: RIGHT - 42,
        share: `${r.share}%`,
      });
    }
    p.y += 20;
    p.rule();
  }

  // LONGEST: the session that worked longest, named unless names are withheld.
  if (d.longest) {
    p.y += 22;
    p.row(w('longestSession'), durationParts(d.longest.ms, L));
    p.y += 17;
    const s = d.longest;
    const named = `${s.project ? `${s.project} / ` : ''}${s.title ?? w('untitled')}`;
    const line = o.hideNames ? `${agentName(s.agent)} · ${w('aSession')}` : named;
    p.push(text(LEFT, p.y, runs(clip(line, INNER, fits11)), { size: 11, fill: c.soft }));
    p.y += 16;
    p.rule();
  }

  // TOKENS, with the sessions that reported none named by CLI.
  const note =
    d.tokens.measured && d.unreported.length > 0
      ? w('notReportedBy', {
          who: d.unreported
            .map((u) => w('sessionsBy', { agent: agentName(u.agent), n: u.n }))
            .join(' · '),
        })
      : undefined;
  p.tokens(d.tokens, note);
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

/** While the week is read: the head, the window, a progress bar and how far it got. */
export function stubSvg(
  o: ReceiptOptions,
  line: string,
  done: number,
  total: number,
  size: ReceiptSize,
): { svg: string; width: number; height: number } {
  const p = new Pen(o);
  const { c } = p;
  p.head('weeklyHeading');
  p.y = 78;
  p.push(text(LEFT, p.y, runs(line), { size: 11, fill: c.soft }));
  p.y += 12;
  const share = total > 0 ? Math.min(1, done / total) : 0;
  p.push(
    `<rect x="${LEFT}" y="${num(p.y)}" width="${INNER}" height="2" fill="${c.faint}"/>`,
    `<rect x="${LEFT}" y="${num(p.y)}" width="${num(INNER * share)}" height="2" fill="${c.ink}"/>`,
  );
  p.y += 21;
  p.push(text(LEFT, p.y, runs(p.w('reading', { done, total })), { size: 11, fill: c.soft }));
  return frame({ body: p.out.join(''), height: Math.ceil(p.y + 24) }, o, size);
}
