import type { ReactNode } from 'react';
import { FigureText } from '../../components/FigureText';
import { StatusMark } from '../../components/Status';
import { useNow } from '../../data/useNow';
import { formatClock, formatDuration } from '../../lib/format';
import css from './TurnHeader.module.css';
import type { TurnItem } from './TurnList';
import { TurnTitle } from './TurnTitle';

interface Props {
  item: TurnItem;
  /** What the view shows under the prompt (the Steps view's phase shares). */
  children?: ReactNode;
  /** Controls beside the prompt's Show full prompt (the execution chain's Copy as Markdown). */
  actions?: ReactNode;
}

/**
 * The open turn's head, shared by the execution chain and the steps view: its label and clock,
 * then the prompt (clamped, readable in full), with the duration, counts and status on the
 * label's line.
 */
export function TurnHeader({ item, children, actions }: Props) {
  const now = useNow();
  const { turn } = item;
  const end = turn.endedAt ? Date.parse(turn.endedAt) : item.status === 'running' ? now : null;
  return (
    // Not a named group: the heading names the prompt, once ("Prompt 2: …").
    <div className={css.header}>
      <div className={css.top}>
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
            <FigureText k="flow.callsTools" params={{ calls: item.calls, tools: item.tools }} />
          </span>
          <StatusMark status={item.status} />
        </span>
      </div>
      <TurnTitle key={turn.id} label={item.label} text={item.prompt} actions={actions} />
      {children}
    </div>
  );
}
