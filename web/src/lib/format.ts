/** Display formatting shared by every view. Missing values always render as a dash. */

export const DASH = '—';

const valid = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** DSH rule: 123ms · 2.8s · 35s · 1m5s · 1h2m. */
export function formatDuration(ms: number | null | undefined): string {
  if (!valid(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m${totalSec % 60}s`;
  const totalMin = Math.floor(totalSec / 60);
  return `${Math.floor(totalMin / 60)}h${totalMin % 60}m`;
}

/** Ticking timers: m:ss, then h:mm:ss. Rendered with tabular numerals so width stays put. */
export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(sec % 60)}` : `${m}:${pad(sec % 60)}`;
}

export function formatNumber(n: number | null | undefined, locale?: string): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString(locale) : DASH;
}

/** Compact token counts for tight spaces: 1.8M, 241k, 820. */
export function formatCompact(n: number | null | undefined, locale?: string): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DASH;
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatPercent(share: number | null | undefined, locale?: string): string {
  if (typeof share !== 'number' || !Number.isFinite(share)) return DASH;
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(share);
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();

export function formatClock(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return DASH;
  const key = timeZone ?? '';
  let fmt = clockFormats.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZone,
    });
    clockFormats.set(key, fmt);
  }
  return fmt.format(t);
}

/**
 * When a quota resets, to the nearest minute (the cache gives one boundary as 23:59:59.9 or as
 * 00:00:00.15): the time alone ("11:00") later today, otherwise with the day as well, in the
 * locale's words and order ("Wed, Oct 28" / "10月28日周三"). `timeZone` is for tests.
 */
export function formatResetTime(
  iso: string,
  now: number,
  locale: string,
  timeZone?: string,
): { date: string | null; clock: string } {
  const t = Math.round(Date.parse(iso) / 60_000) * 60_000;
  const day = (ms: number) =>
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone,
    }).format(ms);
  const clock = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(t);
  if (day(t) === day(now)) return { date: null, clock };
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(t);
  return { date, clock };
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000],
];

const THIN_SPACE = '\u2009';

/**
 * "7 s ago", "3 m ago", "2 h ago", "yesterday", in the UI language: narrow units, with a thin
 * space between the figure and a Latin unit glued to it (zh "3分钟前" stays as it is).
 */
export function formatRelative(iso: string | null | undefined, now: number, locale: string) {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return DASH;
  // A time a little ahead of this clock (a busy session's last write) is now, not "in 1 second".
  const diff = Math.min(0, t - now);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size || unit === 'second')
      return rtf
        .formatToParts(Math.round(diff / size), unit)
        .map((p, i, all) =>
          p.type === 'literal' && all[i - 1]?.type === 'integer' && /^[A-Za-z]/.test(p.value)
            ? THIN_SPACE + p.value
            : p.value,
        )
        .join('');
  }
  return DASH;
}

/** Milliseconds between two ISO times; null when either is missing. */
export function spanMs(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return null;
  const d = Date.parse(end) - Date.parse(start);
  return Number.isFinite(d) ? d : null;
}

/** Time until a reset: "45s", "1h37m", "3d5h"; null once it has passed. */
export function formatCountdown(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 86_400_000) return formatDuration(ms);
  const hours = Math.floor(ms / 3_600_000);
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${d}d${h}h` : `${d}d`;
}

const ELLIPSIS = '…';

/**
 * A path cut in the middle to at most `n` characters, keeping what identifies it: the first
 * segment (its root) and as many trailing segments as fit, e.g. "src/…/server/store.ts". A last
 * segment too long on its own keeps its head and its tail (and so its extension):
 * "very-lo…name.ts". Separators are kept as written, `/` or `\`.
 */
export function middleEllipsis(path: string, n: number): string {
  const max = Math.max(1, Math.floor(n));
  if (path.length <= max) return path;
  const parts = path.split(/([/\\])/); // segments at even indexes, separators at odd
  const segments = parts.filter((_, i) => i % 2 === 0);
  if (segments.length >= 3) {
    // Head: the first segment with its separator ("src/", or "/" for an absolute path).
    const head = `${parts[0]}${parts[1]}`;
    let tail = segments.length - 1; // index into segments of the first one kept at the end
    const tailText = (from: number) => parts.slice(from * 2 - 1).join('');
    if (head.length + ELLIPSIS.length + tailText(tail).length <= max) {
      while (tail > 2 && head.length + ELLIPSIS.length + tailText(tail - 1).length <= max) tail--;
      return `${head}${ELLIPSIS}${tailText(tail)}`;
    }
  }
  const last = segments.at(-1) ?? path;
  if (last.length + 2 <= max && segments.length > 1) {
    const sep = parts.at(-2) ?? '/';
    return `${ELLIPSIS}${sep}${last}`;
  }
  // Even the file name is too long: keep its start and its end.
  const keep = max - ELLIPSIS.length;
  if (keep <= 0) return ELLIPSIS;
  const tailLen = Math.ceil(keep / 2);
  return `${last.slice(0, keep - tailLen)}${ELLIPSIS}${last.slice(last.length - tailLen)}`;
}
