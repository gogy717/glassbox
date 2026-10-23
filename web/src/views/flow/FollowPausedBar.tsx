import { LiveDot } from '../../components/Status';
import { useI18n } from '../../i18n';
import { BackToLatest } from './BackToLatest';
import css from './FollowPausedBar.module.css';
import type { TurnItem } from './TurnList';

interface Props {
  /** The agent's newest turn: the bar says when it is still running or waits for the person. */
  newest: TurnItem | undefined;
  onBack(): void;
}

/**
 * Says that follow mode is paused, and why it matters, at the top of a view's scroll area: in the
 * layout, never over what is being read. Shared by the execution chain and the steps view.
 */
export function FollowPausedBar({ newest, onBack }: Props) {
  const { t } = useI18n();
  const state =
    newest?.status === 'running' || newest?.status === 'approval' ? newest.status : null;
  const text =
    state === 'running'
      ? t('follow.pausedRunning', { turn: newest?.label ?? '' })
      : state === 'approval'
        ? t('follow.pausedWaiting', { turn: newest?.label ?? '' })
        : t('follow.paused');
  return (
    <div className={css.bar}>
      <LiveDot state={state ?? 'complete'} />
      <span className={css.text} role="status">
        {text}
      </span>
      <BackToLatest onClick={onBack} />
    </div>
  );
}
