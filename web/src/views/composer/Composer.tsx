import { Plus, Send, Square } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import type { SessionSummary } from '../../../../src/core/model.js';
import type { RunPermissionMode, RunState } from '../../../../src/shared/runs.js';
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

/** Bottom bar for talking to Claude: continue a session, fork it, or follow up on a run. */
export function Composer({ session, run, client, onNewSession, onRunStarted }: Props) {
  const { t } = useI18n();
  const agent = useSessionAgent();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<StartMode>('resume');
  const [permissionMode, setPermissionMode] = useState<RunPermissionMode>('default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeRun = run && run.status !== 'closed' && run.status !== 'error' ? run : null;
  const failedRun = run?.status === 'error' ? run : null;
  const replying = !!activeRun && REPLYING.has(activeRun.status);
  // Two processes writing one session interleave its transcript: only a closed session resumes.
  const openElsewhere = !!session && !activeRun && session.live !== 'closed' && mode === 'resume';

  // glassbox can only run Claude Code; other agents' sessions are there to look at.
  const viewOnly = !!session && session.agent !== 'claude-code';

  let blocked: string | null = null;
  if (!session) blocked = t('composer.noSession');
  else if (viewOnly) blocked = t('composer.viewOnly', { agent: agentName(session.agent) });
  else if (replying) blocked = t('composer.waiting');
  else if (openElsewhere) blocked = t('composer.busyTerminal');
  const prompt = text.trim();
  const canSend = !blocked && !busy && prompt.length > 0;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setText('');
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
            className={css.secondary}
            disabled={busy || prompt.length === 0}
            onClick={() => void start('fork')}
          >
            {t('composer.restart')}
          </button>
        </div>
      )}
      <div className={css.inputRow}>
        <textarea
          className={css.textarea}
          aria-label={t('composer.message')}
          placeholder={blocked ?? t('composer.placeholder', { agent })}
          rows={1}
          value={text}
          disabled={!!blocked}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {replying && activeRun ? (
          <button
            type="button"
            className={css.secondary}
            onClick={() => void act(() => client.interrupt(activeRun.id))}
          >
            <Square size={13} aria-hidden="true" />
            {t('composer.stop')}
          </button>
        ) : (
          <button type="button" className={css.primary} disabled={!canSend} onClick={send}>
            <Send size={13} aria-hidden="true" />
            {t('composer.send')}
          </button>
        )}
      </div>
      <div className={css.controls}>
        {session && !activeRun && (
          <div className={css.modes} role="radiogroup" aria-label={t('composer.modes')}>
            {(['resume', 'fork'] as const).map((m) => (
              // biome-ignore lint/a11y/useSemanticElements: a two-option segmented control
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                disabled={viewOnly}
                onClick={() => setMode(m)}
              >
                {t(m === 'resume' ? 'composer.continue' : 'composer.fork')}
              </button>
            ))}
          </div>
        )}
        {!activeRun && !viewOnly && (
          <PermissionModeSelect value={permissionMode} onChange={setPermissionMode} />
        )}
        <button type="button" className={css.secondary} onClick={onNewSession}>
          <Plus size={13} aria-hidden="true" />
          {t('composer.newSession')}
        </button>
        {blocked && session && <span className={css.hint}>{blocked}</span>}
        {error && <span className={css.error}>{t('composer.error', { msg: error })}</span>}
      </div>
    </div>
  );
}
