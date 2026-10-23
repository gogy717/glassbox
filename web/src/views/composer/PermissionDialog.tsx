import { MessageCircleQuestion, Shield } from 'lucide-react';
import { useContext, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { PermissionDecision, PermissionRequest } from '../../../../src/shared/runs.js';
import { trapTab } from '../../components/focusTrap';
import { JsonInspector } from '../../components/JsonInspector';
import { useSessionAgent } from '../../data/session-agent';
import { StoreContext } from '../../data/store';
import { useI18n } from '../../i18n';
import css from './Composer.module.css';

interface Props {
  request: PermissionRequest;
  onDecide(d: PermissionDecision): Promise<void> | void;
  /** Escape collapses the prompt without answering; it stays pending. */
  onDismiss?(): void;
}

const field = (input: unknown, key: string) =>
  input && typeof input === 'object' && typeof (input as Record<string, unknown>)[key] === 'string'
    ? ((input as Record<string, unknown>)[key] as string)
    : null;

const noSubscribe = () => () => {};

/**
 * "Conversation 6 · call #1": where the tool call a prompt is about sits in the open session,
 * once the session's records hold it (a prompt can arrive before the call is written).
 */
function useCallRef(toolUseId: string): string | null {
  const { t } = useI18n();
  const store = useContext(StoreContext);
  const open = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    () => store?.getState().open ?? null,
  );
  const call = open?.toolCalls.get(toolUseId);
  const request = call ? open?.requests.get(call.requestId) : undefined;
  const turn = request?.turnId ? open?.turns.get(request.turnId) : undefined;
  return request && turn ? t('tokens.requestRef', { turn: turn.index, n: request.index }) : null;
}

/**
 * A pending permission prompt or AskUserQuestion from a glassbox-owned run, as a quiet panel
 * above the composer: an amber hairline, no fill, no shadow. No timeout. Enter answers nothing
 * (focus starts on the panel itself); Escape only hides it, and it stays pending.
 */
export function PermissionDialog({ request, onDecide, onDismiss }: Props) {
  const { t } = useI18n();
  const agent = useSessionAgent();
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);
  // Take focus (on the prompt itself, so a stray Enter answers nothing) and keep it inside.
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (d: PermissionDecision) => {
    setBusy(true);
    setError(null);
    try {
      await onDecide(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const isAsk = request.toolName === 'AskUserQuestion' && request.questions;
  const where = useCallRef(request.id);
  const Glyph = isAsk ? MessageCircleQuestion : Shield;
  return (
    <section
      ref={ref}
      className={css.prompt}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && onDismiss) {
          e.stopPropagation();
          onDismiss();
        }
        trapTab(e, ref.current);
      }}
    >
      <div className={css.promptHead}>
        <Glyph size={14} aria-hidden="true" />
        <span id={titleId} className={css.promptTitle}>
          {isAsk ? t('perm.ask', { agent }) : t('perm.title', { tool: request.toolName, agent })}
        </span>
        {where && <span className={`${css.promptWhere} num`}>{where}</span>}
        <span className={`${css.promptLabel} section-label`}>
          {t(isAsk ? 'perm.questionLabel' : 'perm.label')}
        </span>
      </div>
      {isAsk ? (
        <Questions request={request} busy={busy} onDecide={decide} />
      ) : (
        <ToolPrompt request={request} busy={busy} onDecide={decide} />
      )}
      {error && <p className={css.error}>{t('perm.error', { msg: error })}</p>}
    </section>
  );
}

interface PartProps {
  request: PermissionRequest;
  busy: boolean;
  onDecide(d: PermissionDecision): void;
}

function ToolPrompt({ request, busy, onDecide }: PartProps) {
  const { t } = useI18n();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const command = field(request.input, 'command');
  const description = field(request.input, 'description');
  return (
    <>
      {description && <p className={css.promptText}>{description}</p>}
      {command ? (
        <pre className={css.command}>{command}</pre>
      ) : (
        <JsonInspector label={request.toolName} data={request.input ?? {}} />
      )}
      {denying ? (
        <div className={css.denyRow}>
          <label className={css.reason}>
            <span>{t('perm.reason')}</span>
            <textarea value={reason} rows={2} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className={css.actions}>
            <button
              type="button"
              className={css.button}
              disabled={busy}
              onClick={() => setDenying(false)}
            >
              {t('perm.cancel')}
            </button>
            <button
              type="button"
              className={css.button}
              data-kind="danger"
              disabled={busy}
              onClick={() =>
                onDecide(
                  reason.trim()
                    ? { decision: 'deny', message: reason.trim() }
                    : { decision: 'deny' },
                )
              }
            >
              {t('perm.confirmDeny')}
            </button>
          </div>
        </div>
      ) : (
        <div className={css.actions}>
          <span className={css.keys}>{t('perm.keys')}</span>
          <button
            type="button"
            className={css.button}
            disabled={busy}
            onClick={() => setDenying(true)}
          >
            {t('perm.deny')}
          </button>
          <button
            type="button"
            className={css.button}
            data-kind="primary"
            disabled={busy}
            onClick={() => onDecide({ decision: 'allow' })}
          >
            {t('perm.allow')}
          </button>
        </div>
      )}
    </>
  );
}

function Questions({ request, busy, onDecide }: PartProps) {
  const { t } = useI18n();
  const questions = request.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const complete = questions.every((q) => (answers[q.question]?.length ?? 0) > 0);
  const toggle = (question: string, label: string, multi: boolean) =>
    setAnswers((a) => {
      const cur = a[question] ?? [];
      const next = multi
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label];
      return { ...a, [question]: next };
    });
  const submit = () => {
    const out: Record<string, string | string[]> = {};
    for (const q of questions) {
      const picked = answers[q.question] ?? [];
      // Keep the options' order, not the click order.
      const ordered = q.options.map((o) => o.label).filter((l) => picked.includes(l));
      out[q.question] = q.multiSelect ? ordered : (ordered[0] ?? '');
    }
    onDecide({ decision: 'allow', answers: out });
  };
  return (
    <>
      {questions.map((q) => (
        <fieldset key={q.question} className={css.question}>
          <legend>
            <span className={css.qHeader}>{q.header}</span> {q.question}
            {q.multiSelect && <small> · {t('perm.multi')}</small>}
          </legend>
          {q.options.map((o) => (
            <label key={o.label} className={css.option}>
              <input
                type={q.multiSelect ? 'checkbox' : 'radio'}
                name={`${request.id}:${q.question}`}
                checked={answers[q.question]?.includes(o.label) ?? false}
                onChange={() => toggle(q.question, o.label, q.multiSelect)}
              />
              <span>
                <b>{o.label}</b>
                {o.description && <small>{o.description}</small>}
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      <div className={css.actions}>
        <span className={css.keys}>{t('perm.keys')}</span>
        <button
          type="button"
          className={css.button}
          disabled={busy}
          onClick={() => onDecide({ decision: 'deny' })}
        >
          {t('perm.skip')}
        </button>
        <button
          type="button"
          className={css.button}
          data-kind="primary"
          disabled={busy || !complete}
          onClick={submit}
        >
          {t('perm.send')}
        </button>
      </div>
    </>
  );
}
