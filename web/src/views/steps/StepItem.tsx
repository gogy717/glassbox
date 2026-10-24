import { ArrowUpRight, Brain, CornerDownRight, MessageSquare } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { CategoryIcon } from '../../components/CategoryIcon';
import { FigureText } from '../../components/FigureText';
import { StatusMark, Ticking } from '../../components/Status';
import { useSessionAgent, useSessionAgentKind } from '../../data/session-agent';
import { useI18n } from '../../i18n';
import { encryptsThinking } from '../../lib/agent-names';
import { fitSummary, formatClock, formatDuration, formatNumber } from '../../lib/format';
import type { Step } from '../../lib/steps';
import css from './StepsView.module.css';

interface Props {
  step: Step;
  onOpen(requestId: string): void;
}

/** Characters of a path shown in the did list before it is cut in the middle. */
const PATH_CHARS = 56;

/**
 * One step on the phase's rail: a node in the step's category colour (red when it failed), the
 * head line in figures, then thought → said → did, and the error that ended it.
 */
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
  const failed = step.did.filter((a) => a.error);
  // Only what asks for attention is marked; a finished step says nothing.
  const mark =
    step.outcome === 'error' || step.outcome === 'interrupted' || step.outcome === 'approval'
      ? step.outcome
      : null;

  return (
    <article
      className={css.step}
      aria-label={t('steps.step', { n: step.index })}
      data-outcome={step.outcome}
      data-cat={step.category}
    >
      <span className={css.node} aria-hidden="true" />
      <div className={css.stepHead}>
        <span className={`${css.stepNo} figure`}>#{step.index}</span>
        <span className="figure">{formatClock(step.startedAt)}</span>
        <span
          className="figure"
          title={step.durationMs === null ? t('flow.startUnknown', { agent }) : undefined}
        >
          {formatDuration(step.durationMs)}
        </span>
        {mark && <StatusMark status={mark} />}
        {/* Unknown (in flight, or not reported) says nothing; a real 0 is a 0. */}
        {step.tokens !== null && (
          <span>
            <FigureText k="common.tokens" params={{ n: formatNumber(step.tokens, intl) }} />
          </span>
        )}
        {step.thought.tokens > 0 && (
          <span className={css.chip}>
            <FigureText
              k="steps.thinkingChip"
              params={{ n: formatNumber(step.thought.tokens, intl) }}
            />
          </span>
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
      <div className={css.line} data-kind="thought">
        <Brain size={14} aria-label={t('steps.thought')} />
        <p className={step.thought.text ? css.text : css.muted}>{thought}</p>
      </div>
      {step.said && (
        <div className={css.line} data-kind="said">
          <MessageSquare size={14} aria-label={t('steps.said')} />
          <p className={css.text}>{step.said}</p>
        </div>
      )}
      {step.did.length > 0 && (
        <div className={css.line} data-kind="did">
          <CornerDownRight size={14} aria-hidden="true" />
          <ul className={css.did} aria-label={t('steps.did')}>
            {step.did.map((a) => (
              <li key={a.toolCallId} data-status={a.status}>
                <CategoryIcon category={a.category} />
                <b>{a.name}</b>
                <code title={a.summary}>{fitSummary(a.summary, PATH_CHARS)}</code>
                {a.status === 'error' || a.status === 'approval' || a.status === 'running' ? (
                  <StatusMark status={a.status} />
                ) : (
                  a.durationMs !== null && (
                    <span className={`${css.didTime} figure`}>{formatDuration(a.durationMs)}</span>
                  )
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {failed.map((a) => (
        <p key={a.toolCallId} className={css.stepError} title={a.error ?? undefined}>
          {/* With two or more, each message says which tool it came from. */}
          {failed.length > 1 && <b>{a.name}: </b>}
          {a.error}
        </p>
      ))}
      {step.error && <p className={css.stepError}>{step.error}</p>}
    </article>
  );
});
