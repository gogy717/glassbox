/** A sign of trouble in words: at length in the summary bar's list and a notification, short on a row. */
import type { TroubleKind, TroubleSignal } from '../../../src/core/model.js';
import type { MessageKey, Params, T } from '../i18n';

export type TroubleForm = 'long' | 'short';

const KEYS: Record<TroubleKind, Record<TroubleForm, MessageKey>> = {
  repeat: { long: 'trouble.long.repeat', short: 'trouble.short.repeat' },
  failing: { long: 'trouble.long.failing', short: 'trouble.short.failing' },
  errors: { long: 'trouble.long.errors', short: 'trouble.short.errors' },
  waiting: { long: 'trouble.long.waiting', short: 'trouble.short.waiting' },
  'long-turn': { long: 'trouble.long.longTurn', short: 'trouble.short.longTurn' },
  compaction: { long: 'trouble.long.compaction', short: 'trouble.short.compaction' },
};

/** How long, in whole minutes, past an hour with its hours: "14 min", "1 h 35 min". */
export function troubleDuration(t: T, ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60
    ? t('trouble.min', { n: min })
    : t('trouble.hourMin', { h: Math.floor(min / 60), m: min % 60 });
}

/**
 * A sign's message key and params: its own, and its clocks read at `now`, how long a wait or a
 * prompt has run (`t`) and the others' median (`m`). `x`, a call, is the one to set in mono.
 */
export function troublePhrase(
  t: T,
  s: TroubleSignal,
  now: number,
  form: TroubleForm,
): { k: MessageKey; params: Params } {
  const params: Params = { ...s.params };
  const since = s.since ? Date.parse(s.since) : Number.NaN;
  if (s.kind === 'waiting' || s.kind === 'long-turn')
    params.t = troubleDuration(t, Number.isNaN(since) ? 0 : now - since);
  if (s.kind === 'long-turn') params.m = troubleDuration(t, Number(s.params.median) || 0);
  return { k: KEYS[s.kind][form], params };
}

/** The sign as one line of plain text. */
export function troubleText(t: T, s: TroubleSignal, now: number, form: TroubleForm): string {
  const { k, params } = troublePhrase(t, s, now, form);
  return t(k, params);
}
