import { Lock, Plus, Send, Square } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import type { SessionSummary } from '../../../../src/core/model.js';
import type { RunPermissionMode, RunState } from '../../../../src/shared/runs.js';
import { Switch } from '../../components/Switch';
import type { RunsClient } from '../../data/runs';
import { useSessionAgent } from '../../data/session-agent';
import { useI18n } from '../../i18n';
import { agentName } from '../../lib/agent-names';
import css from './Composer.module.css';
import { PermissionModeSelect } from './PermissionModeSelect';

interface Props {
  /** The open session, or null on the home screen. */
  session: SessionSummary | null;
  /** The glassbox-owned run attached to this session, if any. */
  run: RunState | null;
  client: RunsClient;
  onNewSession(): void;
  onRunStarted(run: RunState): void;
}

type StartMode = 'resume' | 'fork';
const REPLYING = new Set<RunState['status']>(['starting', 'running', 'waiting-permission']);

/**
 * Bottom bar for talking to Claude: continue a session, fork it, or follow up on a run. It offers
 * the action that is true now: a copy while a terminal holds the session (Continue comes back
 * once it closes), nothing to choose for an agent glassbox cannot run, Stop while a reply runs.
 */
export function Composer({ session, run, client, onNewSession, onRunStarted }: Props) {
  const { t } = useI18n();
  const agent = useSessionAgent();
  const [text, setText] = useState('');
  // The person's pick, if they made one; otherwise the mode follows the session.
  const [choice, setChoice] = useState<StartMode | null>(null);
  // The mode a draft was started under, kept until it is sent or the person picks again: a
  // terminal letting the session go must not change where a message already typed will go.
  const [draftMode, setDraftMode] = useState<StartMode | null>(null);
  const [permissionMode, setPermissionMode] = useState<RunPermissionMode>('default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeRun = run && run.status !== 'closed' && run.status !== 'error' ? run : null;
  const failedRun = run?.status === 'error' ? run : null;
  const replying = !!activeRun && REPLYING.has(activeRun.status);
  // glassbox can only run Claude Code; other agents' sessions are there to look at.
  const viewOnly = !!session && session.agent !== 'claude-code';
  // Two processes writing one session interleave its transcript: only a closed session resumes,
  // so while a terminal holds it, a copy is the way on.
  const terminalOwns = !!session && !viewOnly && !activeRun && session.live !== 'closed';
  const mode: StartMode = terminalOwns ? 'fork' : (draftMode ?? choice ?? 'resume');
  const edit = (value: string) => {
    if (!value.trim()) setDraftMode(null);
    else if (!text.trim()) setDraftMode(mode);
    setText(value);
  };
  const pick = (m: StartMode) => {
    setChoice(m);
    if (text.trim()) setDraftMode(m);
  };

  let blocked: string | null = null;
  if (!session) blocked = t('composer.noSession');
  else if (viewOnly) blocked = t('composer.viewOnly', { agent: agentName(session.agent) });
  else if (replying) blocked = t('composer.waiting');
  const prompt = text.trim();
  const canSend = !blocked && !busy && prompt.length > 0;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setText('');
      setDraftMode(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const start = (m: StartMode) =>
    act(async () => {
      if (!session) return;
      onRunStarted(await client.start({ mode: m, sessionId: session.id, prompt, permissionMode }));
    });

  const send = () => {
    if (!canSend) return;
    if (activeRun) void act(() => client.send(activeRun.id, prompt));
    else void start(mode);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    // Enter that confirms an IME candidate (Chinese/Japanese input) is not a send.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    send();
  };

  return (
    <div className={css.composer}>
      {failedRun && (
        <div className={css.controls}>
          <span className={css.error}>{failedRun.error}</span>
          <button
            type="button"
            className={css.button}
            data-size="small"
            disabled={busy || prompt.length === 0}
            onClick={() => void start('fork')}
          >
            {t('composer.restart')}
          </button>
        </div>
      )}
      {/* Send (or Stop) sits inside the field, at its right. */}
      <div className={css.field} data-off={blocked ? '' : undefined}>
        <textarea
          className={css.textarea}
          aria-label={t('composer.message')}
          placeholder={blocked ?? t('composer.placeholder', { agent })}
          rows={1}
          value={text}
          disabled={!!blocked}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {replying && activeRun ? (
          <button
            type="button"
            className={css.button}
            data-kind="stop"
            onClick={() => void act(() => client.interrupt(activeRun.id))}
          >
            <Square size={12} aria-hidden="true" />
            {t('composer.stop')}
          </button>
        ) : (
          <button
            type="button"
            className={css.button}
            data-kind="primary"
            disabled={!canSend}
            onClick={send}
          >
            <Send size={12} aria-hidden="true" />
            {t('composer.send')}
          </button>
        )}
      </div>
      <div className={css.controls}>
        {session && !activeRun && !viewOnly && (
          <Switch<StartMode>
            label={t('composer.modes')}
            size="small"
            value={mode}
            options={[
              {
                value: 'resume',
                label: t('composer.continue'),
                disabled: terminalOwns,
                title: terminalOwns ? t('composer.busyTerminal') : undefined,
              },
              { value: 'fork', label: t('composer.fork') },
            ]}
            onChange={pick}
            onChoose={pick}
          />
        )}
        {!activeRun && !viewOnly && (
          <PermissionModeSelect value={permissionMode} onChange={setPermissionMode} />
        )}
        <button type="button" className={css.button} data-size="small" onClick={onNewSession}>
          <Plus size={12} aria-hidden="true" />
          {t('composer.newSession')}
        </button>
        {error && <span className={css.error}>{t('composer.error', { msg: error })}</span>}
        {/* Said once, here; the placeholder stays the ordinary one. */}
        {terminalOwns && (
          <span className={css.hint}>
            <Lock size={12} aria-hidden="true" />
            {t('composer.busyTerminal')}
          </span>
        )}
      </div>
    </div>
  );
}
