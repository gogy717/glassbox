import { useEffect, useState } from 'react';
import type { SessionSummary } from '../../../src/core/model.js';
import type { PermissionDecision } from '../../../src/shared/runs.js';
import { shellCommand } from '../../../src/shared/tool-category.js';
import type { OpenPrompt } from '../data/runs';
import { useI18n } from '../i18n';
import { summarizeInput } from '../lib/tool-category';
import promptCss from '../views/composer/Composer.module.css';
import css from './Answer.module.css';

/**
 * Whether the rows that answer prompts (`key`, their ids in order) have stood still for `armMs`:
 * deciding one moves the rows under it up, and a session that starts to wait pushes them down, so
 * the second click of a double-click must not land on the next row's Allow. The dialog arms its
 * buttons the same way. Only counts while `active`, a row there to answer.
 */
export function useArmed(key: string, armMs: number, active: boolean): boolean {
  const [seen, setSeen] = useState(key);
  const [armedFor, setArmedFor] = useState<string | null>(null);
  if (seen !== key) {
    setSeen(key);
    setArmedFor(null);
  }
  useEffect(() => {
    if (!active || armMs <= 0) return;
    const id = setTimeout(() => setArmedFor(key), armMs);
    return () => clearTimeout(id);
  }, [key, armMs, active]);
  return armMs <= 0 || (seen === key && armedFor === key);
}

interface Props {
  session: SessionSummary;
  prompt: OpenPrompt;
  armed: boolean;
  /** Answers a prompt of a glassbox run, as its dialog does (`RunsClient.decide`). */
  onDecide?(runId: string, permissionId: string, d: PermissionDecision): Promise<void> | void;
  onOpen(sessionId: string): void;
}

/**
 * A glassbox run's prompt answered where it is listed: what it wants as its call card will say it
 * (the whole command in the tooltip), then Deny and Allow, sent through the run that holds it as
 * the dialog sends them; Deny without a reason, which the dialog can give. A question and a plan
 * to approve keep Open: the question's options, and the plan read whole, need the dialog.
 * Answered, the row moves on with the next update, and nothing more can be pressed until then; a
 * failure says why and lets it be sent again. Keyed by the prompt, each prompt starts afresh.
 */
export function Answer({ session: s, prompt, armed, onDecide, onOpen }: Props) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { runId, request } = prompt;
  const title = s.title ?? t('sidebar.untitled');
  const wants = summarizeInput({ name: request.toolName, input: request.input });
  const question = request.toolName === 'AskUserQuestion' && request.questions;
  if (question || request.toolName === 'ExitPlanMode')
    return (
      // biome-ignore lint/a11y/useSemanticElements: a row's answer buttons, not a form fieldset
      <div
        className={css.answer}
        role="group"
        aria-label={t(question ? 'home.question' : 'home.plan', { title })}
      >
        <span className={css.wants}>{question ? (question[0]?.question ?? '') : wants}</span>
        <button
          type="button"
          className={promptCss.button}
          data-size="small"
          onClick={() => onOpen(s.id)}
        >
          {t('home.open')}
        </button>
      </div>
    );
  const decide = async (d: PermissionDecision) => {
    setBusy(true);
    setError(null);
    try {
      await onDecide?.(runId, request.id, d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row's answer buttons, not a form fieldset
    <div
      className={css.answer}
      role="group"
      aria-label={t('home.decide', { tool: request.toolName, title })}
    >
      <code className={css.wants} title={shellCommand(request.input) ?? wants}>
        {wants || request.toolName}
      </code>
      {error && (
        <span role="alert" className={css.error}>
          {t('perm.error', { msg: error })}
        </span>
      )}
      <button
        type="button"
        className={promptCss.button}
        data-size="small"
        disabled={!armed || busy}
        onClick={() => void decide({ decision: 'deny' })}
      >
        {t('perm.deny')}
      </button>
      <button
        type="button"
        className={promptCss.button}
        data-size="small"
        data-kind="primary"
        disabled={!armed || busy}
        onClick={() => void decide({ decision: 'allow' })}
      >
        {t('perm.allow')}
      </button>
    </div>
  );
}
