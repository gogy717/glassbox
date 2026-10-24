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
