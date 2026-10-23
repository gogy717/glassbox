import {
  AlertCircle,
  CheckCircle2,
  CircleSlash,
  Clock3,
  LoaderCircle,
  ShieldQuestion,
} from 'lucide-react';
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

const ICONS = {
  waiting: Clock3,
  running: LoaderCircle,
  complete: CheckCircle2,
  error: AlertCircle,
  interrupted: CircleSlash,
  approval: ShieldQuestion,
} as const;

export function StatusPill({ status, label }: { status: UiStatus; label?: string }) {
  const { t } = useI18n();
  const Icon = ICONS[status];
  return (
    <span className={css.pill} data-state={status}>
      <Icon size={12} className={status === 'running' ? 'spin' : undefined} aria-hidden="true" />
      <span data-status-label>{label ?? t(`status.${status}`)}</span>
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
