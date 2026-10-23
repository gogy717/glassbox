import {
  AlertCircle,
  ArrowUpRight,
  Brain,
  LoaderCircle,
  MessageSquare,
  ShieldQuestion,
} from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Ticking } from '../../components/Status';
import { useSessionAgent, useSessionAgentKind } from '../../data/session-agent';
import { useI18n } from '../../i18n';
import { encryptsThinking } from '../../lib/agent-names';
import { formatClock, formatDuration, formatNumber } from '../../lib/format';
import type { Step } from '../../lib/steps';
import { CategoryIcon } from './CategoryIcon';
import css from './StepsView.module.css';

interface Props {
  step: Step;
  onOpen(requestId: string): void;
}

export const StepItem = memo(function StepItem({ step, onOpen }: Props) {
  const { t, intl } = useI18n();
  const agent = useSessionAgent();
  const kind = useSessionAgentKind();
  const encrypted = step.thought.hidden && encryptsThinking(kind);
  const thinkingNow =
    step.outcome === 'running' && step.thought.durationMs === null && step.startedAt;
  let thought: ReactNode;
  if (step.thought.text) thought = step.thought.text;
  else if (thinkingNow && step.startedAt)
    thought = <Ticking since={step.startedAt} labelKey="flow.thinkingNow" />;
  else if (step.thought.durationMs !== null)
    thought = t(encrypted ? 'steps.thoughtEncrypted' : 'steps.thoughtHidden', {
      t: formatDuration(step.thought.durationMs),
    });
  else thought = t(encrypted ? 'steps.noThoughtEncrypted' : 'steps.noThought');

  return (
    <article
      className={css.step}
      aria-label={t('steps.step', { n: step.index })}
      data-outcome={step.outcome}
    >
      <div className={css.stepHead}>
        <span className={css.stepNo}>#{step.index}</span>
        <span className="num">{formatClock(step.startedAt)}</span>
        <span
          className="num"
          title={step.durationMs === null ? t('flow.startUnknown', { agent }) : undefined}
        >
          {formatDuration(step.durationMs)}
        </span>
        {(step.outcome === 'error' ||
          step.outcome === 'interrupted' ||
          step.outcome === 'approval') && (
          <span className={css.outcome} data-outcome={step.outcome}>
            {t(`status.${step.outcome}`)}
          </span>
        )}
        {step.tokens > 0 && (
          <span className="num">{t('common.tokens', { n: formatNumber(step.tokens, intl) })}</span>
        )}
        <button
          type="button"
          className={css.open}
          aria-label={t('steps.openInFlow')}
          title={t('steps.openInFlow')}
          onClick={() => onOpen(step.requestId)}
        >
          <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      </div>
      {step.error && <p className={css.stepError}>{step.error}</p>}
      <div className={css.line} data-kind="thought">
        <Brain size={14} aria-label={t('steps.thought')} />
        <p className={step.thought.text ? css.text : css.muted}>{thought}</p>
        {step.thought.tokens > 0 && (
          <span className={css.chip}>
            {t('steps.thinkingTokens', { n: formatNumber(step.thought.tokens, intl) })}
          </span>
        )}
      </div>
      {step.said && (
        <div className={css.line} data-kind="said">
          <MessageSquare size={14} aria-label={t('steps.said')} />
          <p className={css.text}>{step.said}</p>
        </div>
      )}
      {step.did.length > 0 && (
        <ul className={css.did} aria-label={t('steps.did')}>
          {step.did.map((a) => (
            <li key={a.toolCallId} data-status={a.status}>
              <CategoryIcon category={a.category} />
              <b>{a.name}</b>
              <code title={a.summary}>{a.summary}</code>
              {a.status === 'error' && (
                <span className={css.bad}>
                  <AlertCircle size={12} aria-hidden="true" />
                  {t('status.error')}
                </span>
              )}
              {a.status === 'approval' && (
                <span className={css.approval}>
                  <ShieldQuestion size={12} aria-hidden="true" />
                  {t('status.approval')}
                </span>
              )}
              {a.status === 'running' && (
                <span className={css.running}>
                  <LoaderCircle size={12} className="spin" aria-hidden="true" />
                  {t('status.running')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
});
