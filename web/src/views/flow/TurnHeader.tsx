import type { ReactNode } from 'react';
import { Figures } from '../../components/Figures';
import { StatusMark } from '../../components/Status';
import { useNow } from '../../data/useNow';
import { useI18n } from '../../i18n';
import { formatClock, formatDuration } from '../../lib/format';
import css from './TurnHeader.module.css';
import type { TurnItem } from './TurnList';
import { TurnTitle } from './TurnTitle';

interface Props {
  item: TurnItem;
  /** What the view shows under the prompt (the Steps view's phase shares). */
  children?: ReactNode;
}

/**
 * The open turn's head, shared by the execution chain and the steps view: its label and clock,
 * then the prompt (clamped, readable in full), with the duration, counts and status on the
 * label's line.
 */
export function TurnHeader({ item, children }: Props) {
  const { t } = useI18n();
  const now = useNow();
  const { turn } = item;
  const end = turn.endedAt ? Date.parse(turn.endedAt) : item.status === 'running' ? now : null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of the turn's facts, not a form fieldset
    <div className={css.header} role="group" aria-label={item.label}>
      <div className={css.top}>
        {/* Said once to screen readers, inside the heading. */}
        <span className="section-label" aria-hidden="true">
          {item.label}
        </span>
        <span className={`${css.clock} figure`}>{formatClock(turn.startedAt)}</span>
        <span className={css.meta}>
          <span className="figure">
            {formatDuration(end === null ? null : end - Date.parse(turn.startedAt))}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            <Figures text={t('flow.callsTools', { calls: item.calls, tools: item.tools })} />
          </span>
          <StatusMark status={item.status} />
        </span>
      </div>
      <TurnTitle key={turn.id} label={item.label} text={item.prompt} />
      {children}
    </div>
  );
}
