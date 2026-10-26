import { useEffect, useState } from 'react';
import type { SessionSummary } from '../../../src/core/model.js';
import type { PermissionDecision } from '../../../src/shared/runs.js';
import { shellCommand } from '../../../src/shared/tool-category.js';
import { type OpenPrompt, promptKind } from '../data/runs';
import { useI18n } from '../i18n';
import { summarizeInput } from '../lib/tool-category';
import promptCss from '../views/composer/Composer.module.css';
import { Questions } from '../views/composer/PermissionDialog';
import css from './Answer.module.css';
import { Markdown } from './Markdown';

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
  /**
   * In the Inbox, which has the room: a question answered with the dialog's own controls, a plan
   * shown whole and approved or rejected there, and each answer's key on its button (y, n).
   */
  inline?: boolean;
}

/** The plan an ExitPlanMode prompt asks to approve, as the agent wrote it. */
const planOf = (input: unknown): string => {
  const plan = input && typeof input === 'object' ? (input as { plan?: unknown }).plan : undefined;
  return typeof plan === 'string' ? plan : '';
};

/**
 * A glassbox run's prompt answered where it is listed: what it wants as its call card will say it
 * (the whole command in the tooltip), then Deny and Allow, sent through the run that holds it as
 * the dialog sends them; Deny without a reason, which the dialog can give. On a row a question
 * and a plan to approve keep Open: the question's options, and the plan read whole, need the
 * dialog's room; `inline`, they have it here. Answered, the row moves on with the next update,
 * and nothing more can be pressed until then; a failure says why and lets it be sent again. Keyed
 * by the prompt, each prompt starts afresh.
 */
export function Answer({ session: s, prompt, armed, onDecide, onOpen, inline = false }: Props) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { runId, request } = prompt;
  const title = s.title ?? t('sidebar.untitled');
  const wants = summarizeInput({ name: request.toolName, input: request.input });
  const kind = promptKind(request);
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
  // Inline, each answer says its key: the Inbox presses the button that says it.
  const key = (k: 'y' | 'n') => (inline ? k : undefined);
  const failure = error && (
    <span role="alert" className={css.error}>
      {t('perm.error', { msg: error })}
    </span>
  );
  if (kind !== 'permission' && !inline)
    return (
      // biome-ignore lint/a11y/useSemanticElements: a row's answer buttons, not a form fieldset
      <div
        className={css.answer}
        role="group"
        aria-label={t(kind === 'question' ? 'home.question' : 'home.plan', { title })}
      >
        <span className={css.wants}>
          {kind === 'question' ? (request.questions?.[0]?.question ?? '') : wants}
        </span>
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
  if (kind === 'question')
    return (
      // biome-ignore lint/a11y/useSemanticElements: the questions are fieldsets of their own
      <div className={css.inline} role="group" aria-label={t('home.question', { title })}>
        <Questions
          request={request}
          busy={!armed || busy}
          onDecide={(d) => void decide(d)}
          shortcuts
        />
        {failure}
      </div>
    );
  if (kind === 'plan')
    return (
      // biome-ignore lint/a11y/useSemanticElements: a plan and its answer buttons, not a form
      <div className={css.inline} role="group" aria-label={t('home.plan', { title })}>
        <div className={css.plan}>
          <Markdown text={planOf(request.input)} label={t('home.plan', { title })} />
        </div>
        <div className={`${css.answer} ${css.end}`}>
          {failure}
          <button
            type="button"
            className={promptCss.button}
            disabled={!armed || busy}
            aria-keyshortcuts="n"
            onClick={() => void decide({ decision: 'deny' })}
          >
            {t('perm.reject')}
          </button>
          <button
            type="button"
            className={promptCss.button}
            data-kind="primary"
            disabled={!armed || busy}
            aria-keyshortcuts="y"
            onClick={() => void decide({ decision: 'allow' })}
          >
            {t('perm.approve')}
          </button>
        </div>
      </div>
    );
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
      {failure}
      <button
        type="button"
        className={promptCss.button}
        data-size="small"
        disabled={!armed || busy}
        aria-keyshortcuts={key('n')}
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
        aria-keyshortcuts={key('y')}
        onClick={() => void decide({ decision: 'allow' })}
      >
        {t('perm.allow')}
      </button>
    </div>
  );
}
