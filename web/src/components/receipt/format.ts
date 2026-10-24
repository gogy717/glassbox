/**
 * How a receipt words the app's figures. The numbers are the app's own; only their dress differs
 * ("4h 12m" for the Summary bar's "4h12m"), as a printed slip reads.
 */
import type { Locale } from '../../i18n';

/** A figure with its units: the digits go in the mono face, the units after them as given. */
export type Parts = { digits: string; unit: string }[];

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A duration as the receipt prints it: "4h 12m", "38m", "4m 12s", "12s"; in Chinese "4 小时 12 分".
 * Minutes alone from ten minutes up; seconds below that, where they still say something.
 */
export function durationParts(ms: number, locale: Locale): Parts {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const u = locale === 'zh' ? { h: ' 小时 ', m: ' 分', s: ' 秒' } : { h: 'h ', m: 'm', s: 's' };
  if (h > 0)
    return [
      { digits: String(h), unit: u.h },
      { digits: pad(m), unit: u.m },
    ];
  if (m >= 10) return [{ digits: String(m), unit: u.m }];
  if (m > 0)
    return [
      { digits: String(m), unit: `${u.m} ` },
      { digits: pad(sec), unit: u.s },
    ];
  return [{ digits: String(sec), unit: u.s }];
}

export const partsText = (p: Parts) => p.map((x) => x.digits + x.unit).join('');

/** Less than one minute, or one second: "<1m", "<1s"; in Chinese "<1 分", "<1 秒". */
export function underOne(unit: 'min' | 's', locale: Locale): Parts {
  const zh = locale === 'zh';
  return [{ digits: '<1', unit: unit === 'min' ? (zh ? ' 分' : 'm') : zh ? ' 秒' : 's' }];
}

/** Whole minutes as the receipt prints a duration of ten minutes or more: "4h 12m", "38m". */
export function minuteParts(minutes: number, locale: Locale): Parts {
  const u = locale === 'zh' ? { h: ' 小时 ', m: ' 分' } : { h: 'h ', m: 'm' };
  const h = Math.floor(minutes / 60);
  return h > 0
    ? [
        { digits: String(h), unit: u.h },
        { digits: pad(minutes % 60), unit: u.m },
      ]
    : [{ digits: String(minutes), unit: u.m }];
}

const DAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_EN = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const DAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** Local hh:mm. */
export const clock = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** "Fri 24 Oct 2026", or "2026-10-24 周五". */
export function day(t: number, locale: Locale): string {
  const d = new Date(t);
  if (locale === 'zh')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${DAYS_ZH[d.getDay()]}`;
  return `${DAYS_EN[d.getDay()]} ${d.getDate()} ${MONTHS_EN[d.getMonth()]} ${d.getFullYear()}`;
}

/** The serial under the barcode: "a3f9 · 2026 1024 · 0914 1326". */
export function serial(nativeId: string, start: number | null, end: number): string {
  const d = new Date(start ?? end);
  const hm = (t: number) => clock(t).replace(':', '');
  const id =
    nativeId
      .replace(/[^0-9a-z]/gi, '')
      .slice(0, 4)
      .toLowerCase() || '0000';
  const date = `${d.getFullYear()} ${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  return `${id} · ${date} · ${start === null ? hm(end) : `${hm(start)} ${hm(end)}`}`;
}

/** "Opus 5.5" for claude-opus-5-5 (dated ids too); any other model as its id. */
export function modelName(id: string): string {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d))?(?:-\d{8})?$/i.exec(id);
  if (!m) return id;
  const family = (m[1] as string).charAt(0).toUpperCase() + (m[1] as string).slice(1).toLowerCase();
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** Date and file-name stamp: "20261024-0914". */
export function stamp(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${clock(t).replace(':', '')}`;
}

/** "Mon 19 Oct", or "10-19 周一": a day of this week, without its year. */
export function shortDay(t: number, locale: Locale): string {
  const d = new Date(t);
  if (locale === 'zh') return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${DAYS_ZH[d.getDay()]}`;
  return `${DAYS_EN[d.getDay()]} ${d.getDate()} ${MONTHS_EN[d.getMonth()]}`;
}

/** The weekday as the grid labels its rows: "Mo"…"Su", or 一…日. */
export function weekdayMark(t: number, locale: Locale): string {
  const i = new Date(t).getDay();
  return locale === 'zh'
    ? (['日', '一', '二', '三', '四', '五', '六'][i] as string)
    : (['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][i] as string);
}

/** "Thu 23:00", or "周四 23 时": the hour an hour bucket starts. */
export function hourOf(t: number, locale: Locale): string {
  const d = new Date(t);
  return locale === 'zh'
    ? `${DAYS_ZH[d.getDay()]} ${d.getHours()} 时`
    : `${DAYS_EN[d.getDay()]} ${pad(d.getHours())}:00`;
}

/** A count as a receipt prints it: "1,204" in English, "1204" in Chinese. */
export const count = (n: number, locale: Locale) =>
  locale === 'zh' ? String(n) : n.toLocaleString('en-US');

/** The ISO 8601 week of `t` (local date): its year and number, e.g. [2026, 43]. */
export function isoWeek(t: number): [number, number] {
  const d = new Date(t);
  const day = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dow);
  const year = day.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  return [year, Math.ceil(((day.getTime() - jan1) / 86_400_000 + 1) / 7)];
}

/** "1019" for 19 October. */
const monthDay = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
};

/**
 * The weekly receipt's serial: "W43 · 2026 1019 → 1024 2041" (the ISO week as the file name has
 * it, W05 for the fifth; from, to and the time printed), or "7D · 2026 1017 2100 → 1024 2041" for
 * the last 7 days, which start on an hour.
 */
export function weekSerial(kind: 'week' | '7d', start: number, now: number): string {
  const hm = (t: number) => clock(t).replace(':', '');
  const from = `${new Date(start).getFullYear()} ${monthDay(start)}`;
  return kind === 'week'
    ? `W${String(isoWeek(start)[1]).padStart(2, '0')} · ${from} → ${monthDay(now)} ${hm(now)}`
    : `7D · ${from} ${hm(start)} → ${monthDay(now)} ${hm(now)}`;
}
