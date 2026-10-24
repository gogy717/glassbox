/**
 * The weekly receipt as text: a fenced block of at most 60 lines and 44 columns, line for line the
 * image's. The grid prints one character an hour (`·` none, `░` under 10 minutes, `▒` under 40,
 * `█` more, blank for hours to come) with a `|` after the current hour on today's row, the other
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
import { QUIET_MS, type WeekReceipt, weekAge } from './week';
import { elapsedWords, inkOf, type WeekElsewhere, windowLine } from './weekSvg';

const SHADE = { none: '·', low: '░', mid: '▒', high: '█', future: ' ', out: ' ' } as const;

/** The grid's rows as text, the cursor marked on today's row. */
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
  const count = (n: number) => countOf(n, 'en');
  const rule = '-'.repeat(COLUMNS);
  const empty = d.sessions === 0;
  const quiet = !empty && d.kind === 'week' && weekAge(d) < QUIET_MS;
  const out: string[] = ['```'];

  out.push(zh ? `glassbox · ${w('weeklyHeading')}` : spread('glassbox', head('weeklyHeading')));
  out.push(clip(windowLine(d, L, w), COLUMNS, cols));
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
    out.push(zh ? lead(dur(d.agentMs), w('agentTime')) : spread(head('agentTime'), dur(d.agentMs)));
  }
  out.push(rule);
  out.push(head('week'));
  out.push(...gridLines(d, zh, L));

  const close = (measured: boolean) => {
    out.push(rule);
    out.push(centred(weekSerial(d.kind, d.start, d.now)));
    out.push(...footLines(L, measured));
    out.push('```');
    return clean(out.join('\n'));
  };
  if (empty || quiet) {
    out.push('');
    const said = empty
      ? w(d.kind === 'week' ? 'noSessions' : 'noSessions7')
      : w('quiet', { elapsed: elapsedWords(weekAge(d), (k, q) => w(k, q)), n: d.sessions });
    out.push(...wrapCols(said, 3));
    if (elsewhere && elsewhere.sessions > 0 && d.kind === 'week')
      out.push(
        ...wrapCols(w('wayOut', { n: elsewhere.sessions, time: dur(elsewhere.agentMs) }), 3),
      );
    return close(!empty && d.tokens.measured);
  }

  if (d.busiest) {
    const at = hourOf(d.busiest.at, L);
    const v = dur(d.busiest.ms);
    out.push(
      zh ? lead(v, `${w('busiestHour')}（${at}）`) : dots(`${w('busiestHour')} `, ` ${at} · ${v}`),
    );
  }
  if (d.afterHours !== null) {
    const share = `${Math.round(d.afterHours * 100)}%`;
    out.push(zh ? lead(share, w('afterHours')) : dots(`${w('afterHours')} `, ` ${share}`));
  }
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
      const share = `${r.share}%`;
      out.push(
        zh
          ? lead(dur(r.ms), `${share.padStart(4)}  ${agentName(r.agent)}`)
          : `${dots(`${agentName(r.agent)} `, ` ${dur(r.ms)}`, COLUMNS - 5)}${share.padStart(5)}`,
      );
    }
    out.push(rule);
  }

  if (d.longest) {
    const s = d.longest;
    const v = dur(s.ms);
    out.push(zh ? lead(v, w('longestSession')) : dots(`${w('longestSession')} `, ` ${v}`));
    const named = `${s.project ? `${s.project} / ` : ''}${s.title ?? w('untitled')}`;
    out.push(clip(o.hideNames ? `${agentName(s.agent)} · ${w('aSession')}` : named, COLUMNS, cols));
    out.push(rule);
  }

  const note =
    d.tokens.measured && d.unreported.length > 0
      ? w('notReportedBy', {
          who: d.unreported
            .map((u) => w('sessionsBy', { agent: agentName(u.agent), n: u.n }))
            .join(' · '),
        })
      : undefined;
  out.push(...tokenLines(d.tokens, L, note));
  out.push(centred(weekSerial(d.kind, d.start, d.now)));
  out.push(...footLines(L, d.tokens.measured));
  out.push('```');
  return clean(out.join('\n'));
}
