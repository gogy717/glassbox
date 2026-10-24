/**
 * The weekly receipt as text: a fenced block of at most 60 lines and 44 columns, line for line the
 * image's. The grid prints one character an hour (`·` none, `░` under 10 minutes, `▒` under 40,
 * `█` more, blank for hours to come) with a `|` after the hour the receipt ends in, the other
 * rows spaced to match. Figures are ASCII and, in Chinese, come first (R9); so does the grid, its
 * weekday after it.
 */
import { agentName } from '../../lib/agent-names';
import {
  count as countOf,
  durationParts,
  hourOf,
  partsText,
  weekdayMark,
  weekSerial,
} from './format';
import { clean } from './printed';
import { categoryLine, clip } from './rows';
import type { ReceiptOptions } from './slip';
import { type ReceiptKey, rt } from './strings';
import {
  COLUMNS,
  centred,
  cols,
  dots,
  footLines,
  lead,
  spread,
  tokenLines,
  wrapCols,
} from './text';
import { isQuiet, longestLine, unreportedLine, type WeekReceipt } from './week';
import {
  cliParts,
  inkOf,
  quietLine,
  shareText,
  timeParts,
  type WeekElsewhere,
  wayOutLine,
  windowLine,
} from './weekSvg';

const SHADE = { none: '·', low: '░', mid: '▒', high: '█', future: ' ', out: ' ' } as const;

/** The grid's rows as text, the end marked on its row. */
export function gridLines(d: WeekReceipt, zh: boolean, L: ReceiptOptions['locale']): string[] {
  const empty = d.sessions === 0;
  return d.grid.map((cells, row) => {
    const chars: string[] = cells.map((c) => (empty && c.state !== 'out' ? ' ' : SHADE[inkOf(c)]));
    chars.splice(d.cursor.col + 1, 0, row === d.cursor.row ? '|' : ' ');
    const mark = weekdayMark(d.rows[row] ?? d.start, L);
    return zh ? `${chars.join('')}  ${mark}` : `${mark} ${chars.join('')}`.trimEnd();
  });
}

export function weekText(
  d: WeekReceipt,
  o: ReceiptOptions,
  elsewhere: WeekElsewhere | null = null,
): string {
  const L = o.locale;
  const zh = L === 'zh';
  const w = (key: ReceiptKey, params?: Record<string, string | number>) => rt(L, key, params);
  const head = (key: ReceiptKey) => (zh ? w(key) : w(key).toUpperCase());
  const dur = (ms: number) => partsText(durationParts(ms, 'en'));
  /** A time, "—" when nothing was timed. */
  const time = (ms: number) => partsText(timeParts(ms, 'en'));
  const count = (n: number) => countOf(n, 'en');
  const rule = '-'.repeat(COLUMNS);
  const empty = d.sessions === 0;
  const out: string[] = ['```'];

  out.push(zh ? `glassbox · ${w('weeklyHeading')}` : spread('glassbox', head('weeklyHeading')));
  out.push(clip(windowLine(d.kind, d.start, d.now, L, w), COLUMNS, cols));
  if (!empty) {
    out.push(
      clip(
        d.clis.length > 3
          ? `${w('clisN', { n: d.clis.length })} · ${w('projectsN', { n: d.projects })}`
          : d.clis.map(agentName).join(' · '),
        COLUMNS,
        cols,
      ),
    );
    const hero = time(d.agentMs);
    out.push(zh ? lead(hero, w('agentTime')) : spread(head('agentTime'), hero));
    if (d.work.subAgents > 0) {
      const v = time(d.sessionMs);
      out.push(zh ? lead(v, w('sessionTime')) : dots(`${w('sessionTime')} `, ` ${v}`));
    }
  }
  out.push(rule);
  out.push(head(d.kind === 'week' ? 'week' : 'last7'));
  out.push(...gridLines(d, zh, L));

  const close = (measured: boolean) => {
    out.push(rule);
    out.push(centred(weekSerial(d.kind, d.start, d.now)));
    out.push(...footLines(L, measured));
    out.push('```');
    return clean(out.join('\n'));
  };
  if (empty || isQuiet(d)) {
    out.push('');
    const said = empty ? w(d.kind === 'week' ? 'noSessions' : 'noSessions7') : quietLine(d, w, dur);
    out.push(...wrapCols(said, 3));
    if (elsewhere && elsewhere.sessions > 0 && d.kind === 'week')
      out.push(...wrapCols(wayOutLine(elsewhere, w, dur), 3));
    return close(!empty && d.tokens.measured);
  }

  // "—" for both in a week of which nothing was timed.
  if (d.busiest) {
    const at = hourOf(d.busiest.at, L);
    const v = dur(d.busiest.ms);
    out.push(
      zh ? lead(v, `${w('busiestHour')}（${at}）`) : dots(`${w('busiestHour')} `, ` ${at} · ${v}`),
    );
  } else out.push(zh ? lead('—', w('busiestHour')) : dots(`${w('busiestHour')} `, ' —'));
  const share = d.afterHours !== null ? `${Math.round(d.afterHours * 100)}%` : '—';
  out.push(zh ? lead(share, w('afterHours')) : dots(`${w('afterHours')} `, ` ${share}`));
  out.push(rule);

  out.push(head('work'));
  const k = d.work;
  const width = Math.max(
    5,
    ...[d.sessions, k.requests, k.toolCalls, k.subAgents, k.failures].map((n) => count(n).length),
  );
  const work = (n: number, key: ReceiptKey, more = '') => {
    if (n > 0) out.push(`${count(n).padStart(width)}  ${w(key, { n })}${more}`);
  };
  work(d.sessions, 'sessions', d.projects > 0 ? ` · ${w('projectsN', { n: d.projects })}` : '');
  work(k.requests, 'modelCalls');
  work(k.toolCalls, 'toolCalls');
  if (k.toolCalls > 0 && k.categories.length > 0) {
    const indent = ' '.repeat(width + 2);
    const fits = (line: string) => cols(line) <= COLUMNS - indent.length;
    out.push(`${indent}${categoryLine(k.categories, L, fits, count)}`);
  }
  work(k.subAgents, 'subAgents');
  work(k.failures, 'failures');
  out.push(rule);

  if (d.byCli.length > 1) {
    out.push(head('byCli'));
    for (const r of d.byCli) {
      const share = r.share === null ? '' : shareText(r.share);
      const v = partsText(cliParts(r, d.cliUnit, 'en'));
      out.push(
        zh
          ? lead(v, `${share.padStart(4)}  ${agentName(r.agent)}`)
          : `${dots(`${agentName(r.agent)} `, ` ${v}`, COLUMNS - 5)}${share.padStart(5)}`,
      );
    }
    out.push(rule);
  }

  const longest = d.longest ? time(d.longest.ms) : '—';
  out.push(
    zh ? lead(longest, w('longestSession')) : dots(`${w('longestSession')} `, ` ${longest}`),
  );
  if (d.longest) out.push(clip(longestLine(d.longest, o.hideNames, w), COLUMNS, cols));
  out.push(rule);

  const note = unreportedLine(d, L, (line) => cols(line) <= COLUMNS);
  out.push(...tokenLines(d.tokens, L, note ?? undefined));
  out.push(centred(weekSerial(d.kind, d.start, d.now)));
  out.push(...footLines(L, d.tokens.measured));
  out.push('```');
  return clean(out.join('\n'));
}
