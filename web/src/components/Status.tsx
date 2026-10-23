import { Check, X } from 'lucide-react';
import type { LiveState, RunStatus } from '../../../src/core/model.js';
import { useNow } from '../data/useNow';
import { type MessageKey, useI18n } from '../i18n';
import { DASH, formatElapsed } from '../lib/format';
import css from './Status.module.css';

/**
 * The four DSH states plus 'interrupted' for requests the user stopped and 'approval' for a
 * tool that is blocked on the person answering a permission prompt.
 */
export type UiStatus = 'waiting' | 'running' | 'complete' | 'error' | 'interrupted' | 'approval';

/**
 * A state's colour as a 6px dot, in one of two vocabularies that both say 'waiting':
 * - `kind="live"` (the default): a session's live state. Its 'waiting' is "waiting for you", the
 *   amber dot with a soft ring.
 * - `kind="status"`: a request, tool, agent or run status. Its 'waiting' (and the model's
 *   'unknown') is "started, never seen to end", a hollow faint dot as `StatusMark` draws it; only
 *   'approval' is ringed.
 *
 * Next to the state's name it is decoration; on its own it needs `label`, which it then carries
 * as its tooltip and accessible name.
 */
export function LiveDot({
  kind = 'live',
  state,
  label,
}:
  | { kind?: 'live'; state: LiveState; label?: string }
  | { kind: 'status'; state: UiStatus | RunStatus; label?: string }) {
  if (label)
    return (
      <span
        className={css.dot}
        data-kind={kind}
        data-state={state}
        role="img"
        aria-label={label}
        title={label}
      />
    );
  return <span className={css.dot} data-kind={kind} data-state={state} aria-hidden="true" />;
}

/**
 * A status as a quiet mark: a dot or a glyph, then the word, with no fill. Only the states that
 * ask for attention colour their word: running (accent), waiting for you (amber, bold, ringed)
 * and failed (red, bold). Complete is the normal case and stays muted; interrupted has an amber
 * dot and a muted word; 'waiting' (started, never seen to end) is a hollow faint dot.
 *
 * - `label` replaces the state's own word.
 * - `compact` shows the glyph alone, for dense lists, named and titled by the word. Only
 *   complete (a check) and failed (an ×) have a glyph whose shape says the state; the dot states
 *   would differ by colour alone, so they keep their word.
 */
export function StatusMark({
  status,
  label,
  compact = false,
}: {
  status: UiStatus;
  label?: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const word = label ?? t(`status.${status}`);
  const mark =
    status === 'complete' ? (
      <Check size={12} strokeWidth={2.25} className={css.glyph} aria-hidden="true" />
    ) : status === 'error' ? (
      <X size={12} strokeWidth={2.5} className={css.glyph} aria-hidden="true" />
    ) : (
      <span className={css.markDot} aria-hidden="true" />
    );
  if (compact && (status === 'complete' || status === 'error'))
    return (
      <span className={css.mark} data-state={status} role="img" aria-label={word} title={word}>
        {mark}
      </span>
    );
  return (
    <span className={css.mark} data-state={status}>
      {mark}
      <span data-status-label>{word}</span>
    </span>
  );
}

/** Stands in for the clock while the label is split around it. */
const CLOCK = '\u0000';

/**
 * A label with a live m:ss counter since `since`; only this node re-renders each second. The
 * counter alone is a `.figure` (mono, tabular), so it does not jitter while the words around it
 * stay in the UI face: a zh label never falls into a monospace CJK face. `labelKey` holds `{t}`.
 */
export function Ticking({ since, labelKey }: { since: string; labelKey: MessageKey }) {
  const { t } = useI18n();
  const now = useNow();
  const start = Date.parse(since);
  const elapsed = Number.isFinite(start) ? formatElapsed(now - start) : DASH;
  const [before, after = ''] = t(labelKey, { t: CLOCK }).split(CLOCK);
  return (
    <span>
      {before}
      <span className="figure">{elapsed}</span>
      {after}
    </span>
  );
}
