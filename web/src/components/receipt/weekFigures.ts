/**
 * The weekly receipt's figures as words: a cell's ink, a CLI's time and share, a time or "—". Apart
 * from the slip's drawing (and its fonts), so the Stats page prints them without loading it.
 */
import type { Locale } from '../../i18n';
import { durationParts, minuteParts, type Parts, underOne } from './format';
import type { GridCell, WeekReceipt } from './week';

/** Agent minutes in an hour as ink: none, under 10, under 40, 40 and up (parallel agents pass 60). */
export function inkOf(
  cell: Pick<GridCell, 'ms' | 'state'>,
): 'future' | 'none' | 'low' | 'mid' | 'high' | 'out' {
  if (cell.state !== 'past') return cell.state;
  const min = cell.ms / 60_000;
  return cell.ms <= 0 ? 'none' : min < 10 ? 'low' : min < 40 ? 'mid' : 'high';
}

/** The share a CLI's row prints: "76%", or "<1%" for one that did a little (DR4). */
export const shareText = (share: number | '<1') => `${share}%`;

/** What a figure prints when nothing it comes from was timed (G8). */
export const DASH: Parts = [{ digits: '—', unit: '' }];

/** A time as printed, "—" when nothing was timed. */
export const timeParts = (ms: number, L: Locale): Parts => (ms > 0 ? durationParts(ms, L) : DASH);

/**
 * A CLI's time as printed: its share of the hero's minutes (or seconds); "<1m" ("<1s") when it
 * worked but its share comes to none, the unit going to the others so the rows still add up
 * (DR12); "—" when it has no time at all.
 */
export function cliParts(
  r: WeekReceipt['byCli'][number],
  unit: WeekReceipt['cliUnit'],
  L: Locale,
): Parts {
  if (r.ms === 0) return DASH;
  if (r.units === 0) return underOne(unit, L);
  return unit === 'min' ? minuteParts(r.units, L) : durationParts(r.units * 1000, L);
}
