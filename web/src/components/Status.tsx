import { Check, X } from 'lucide-react';
import type { LiveState } from '../../../src/core/model.js';
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
 * A state's colour as a dot. Next to the state's name it is decoration; on its own it needs
 * `label`, which it then carries as its tooltip and accessible name.
 */
export function LiveDot({
  state,
  label,
}: {
  state: LiveState | UiStatus | 'unknown';
  label?: string;
}) {
  if (label)
    return (
      <span className={css.dot} data-state={state} role="img" aria-label={label} title={label} />
    );
  return <span className={css.dot} data-state={state} aria-hidden="true" />;
}

/**
 * A status as a quiet mark: a dot or a glyph, then the word, with no fill. Only the states that
 * ask for attention carry colour: running (accent), waiting for you (amber, bold, ringed) and
 * failed (red, bold). Complete is the normal case and stays muted; interrupted is amber but not
 * bold; 'waiting' (started, never seen to end) is a hollow faint dot.
 *
 * - `label` replaces the state's own word.
 * - `compact` shows only the dot or glyph, for dense lists; the word is then its accessible name
 *   and tooltip.
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
  if (compact)
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

/** A label with a live m:ss counter since `since`; only this node re-renders each second. */
export function Ticking({ since, labelKey }: { since: string; labelKey: MessageKey }) {
  const { t } = useI18n();
  const now = useNow();
  const start = Date.parse(since);
  const elapsed = Number.isFinite(start) ? formatElapsed(now - start) : DASH;
  return <span className="num">{t(labelKey, { t: elapsed })}</span>;
}
