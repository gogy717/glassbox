import { Plus } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentKind, SessionSummary } from '../../../src/core/model.js';
import type { PermissionDecision } from '../../../src/shared/runs.js';
import { shellCommand } from '../../../src/shared/tool-category.js';
import { AgentTag } from '../components/AgentTag';
import { Delayed } from '../components/Delayed';
import { SessionRow } from '../components/SessionRow';
import { needsYou } from '../data/needs-you';
import type { OpenPrompt } from '../data/runs';
import { useRovingFocus } from '../data/useRovingFocus';
import { type MessageKey, useI18n } from '../i18n';
import { isListed } from '../lib/sessions';
import { summarizeInput } from '../lib/tool-category';
import { waitKind } from '../lib/waiting';
import promptCss from './composer/Composer.module.css';
import { PROMPT_ARM_MS } from './composer/PermissionDialog';
import css from './Home.module.css';

interface Props {
  sessions: SessionSummary[];
  loaded: boolean;
  now: number;
  showProbes: boolean;
  /** The sessions whose glassbox run failed, with its error (`failedSessions`). */
  failures: ReadonlyMap<string, string | null>;
  /** The prompts glassbox runs hold open, by session (`openPrompts`); the rest a terminal holds. */
  prompts?: ReadonlyMap<string, OpenPrompt>;
  /** The session open last: back on Home, its row keeps the tab stop. */
  lastOpened?: string | null;
  onOpen(sessionId: string): void;
  onNewSession(): void;
  /** Answers a prompt of a glassbox run, as its dialog does (`RunsClient.decide`). */
  onDecide?(runId: string, permissionId: string, d: PermissionDecision): Promise<void> | void;
  /** How long Allow and Deny stay inert after the rows move; PROMPT_ARM_MS unless a test says. */
  armMs?: number;
}

const RECENT = 6;
const NO_PROMPTS: ReadonlyMap<string, OpenPrompt> = new Map();
const newestFirst = (a: SessionSummary, b: SessionSummary) =>
  b.updatedAt.localeCompare(a.updatedAt);

/** Where each agent's sessions are read from, and the options that move or drop them. */
const WHERE: { agent: AgentKind; dir: string; options: string[] }[] = [
  {
    agent: 'claude-code',
    dir: '~/.claude/projects',
    options: ['--claude-dir', '$CLAUDE_CONFIG_DIR'],
  },
  { agent: 'codex', dir: '~/.codex', options: ['--codex-dir', '$CODEX_HOME', '--no-codex'] },
  { agent: 'grok', dir: '~/.grok', options: ['--grok-dir', '$GROK_HOME', '--no-grok'] },
  { agent: 'oh-my-pi', dir: '~/.omp/agent/sessions', options: ['--omp-dir', '--no-omp'] },
  {
    agent: 'opencode',
    dir: '~/.local/share/opencode',
    options: ['--opencode-dir', '$XDG_DATA_HOME', '--no-opencode'],
  },
];

/**
 * The board: three flat lists of the sidebar's rows at card density (the project leads the
 * title), most urgent first. Needs you: the sessions waiting for you, the longest wait first,
 * each saying what it waits for. Working: the busy ones, each saying what it is doing. Recent:
 * the rest, most recently active first. The first two stay when empty, and say so; New session
 * sits in the header. The rows are one tab stop; the arrow keys move between them and Enter
 * opens one. With no sessions, where glassbox looks.
 */
export function Home({
  sessions,
  loaded,
  now,
  showProbes,
  failures,
  prompts = NO_PROMPTS,
  lastOpened = null,
  onOpen,
  onNewSession,
  onDecide,
  armMs = PROMPT_ARM_MS,
}: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const visible = useMemo(
    () => sessions.filter((s) => isListed(s, showProbes)),
    [sessions, showProbes],
  );
  const waiting = useMemo(() => needsYou(sessions, showProbes), [sessions, showProbes]);
  const working = useMemo(
    () => visible.filter((s) => s.live === 'busy').sort(newestFirst),
    [visible],
  );
  const recent = useMemo(
    () =>
      visible
        .filter((s) => s.live !== 'waiting' && s.live !== 'busy')
        .sort(newestFirst)
        .slice(0, RECENT),
    [visible],
  );
  const rows = [...waiting, ...working, ...recent];
  const roving = useRovingFocus(
    ref,
    rows.map((s) => s.id),
    lastOpened,
  );
  // The rows and the prompts on them: a run that asks again at once changes its row in place.
  const armed = useArmed(
    waiting.map((s) => `${s.id} ${prompts.get(s.id)?.request.id ?? ''}`).join('\n'),
    armMs,
    waiting.some((s) => prompts.has(s.id)),
  );

  if (!loaded)
    return (
      <Delayed>
        <p className={css.placeholder}>{t('home.connecting')}</p>
      </Delayed>
    );

  const newSession = (
    <button type="button" className={css.newSession} onClick={onNewSession}>
      <Plus size={14} aria-hidden="true" />
      {t('composer.newSession')}
    </button>
  );

  if (visible.length === 0)
    return (
      <div className={css.home}>
        <section className={css.empty} aria-labelledby="home-empty">
          <h1 id="home-empty">{t('home.emptyTitle')}</h1>
          <p>{t('home.emptyBody1')}</p>
          <ul className={css.where}>
            {WHERE.map((w) => (
              <li key={w.agent}>
                <AgentTag kind={w.agent} />
                <code>{w.dir}</code>
                <code className={css.options}>{w.options.join('  ')}</code>
              </li>
            ))}
          </ul>
          <p>{t('home.emptyBody2')}</p>
          {newSession}
        </section>
      </div>
    );

  // A prompt or question a terminal holds is answered there; a turn is not answered at all.
  const answerInTerminal = (s: SessionSummary) =>
    s.live === 'waiting' && !prompts.has(s.id) && waitKind(s.activity) !== 'turn';
  // One a glassbox run holds is answered here, from its row; each prompt afresh.
  const answer = (s: SessionSummary) => {
    const p = prompts.get(s.id);
    return p ? (
      <Answer
        key={p.request.id}
        session={s}
        prompt={p}
        armed={armed}
        onDecide={onDecide}
        onOpen={onOpen}
      />
    ) : undefined;
  };
  const list = (items: SessionSummary[]) => (
    <ul className={css.rows}>
      {items.map((s) => (
        <li key={s.id}>
          <SessionRow
            session={s}
            selected={false}
            now={now}
            density="card"
            failure={failures.get(s.id)}
            note={answerInTerminal(s) ? t('home.answerInTerminal') : undefined}
            footer={answer(s)}
            roving={roving(s.id)}
            onSelect={onOpen}
          />
        </li>
      ))}
    </ul>
  );
  const section = (
    name: 'needsYou' | 'working' | 'recent',
    items: SessionSummary[],
    none: MessageKey | null,
    extra?: ReactNode,
  ) => (
    <section className={css.section} aria-labelledby={`home-${name}`} data-section={name}>
      <div className={css.header}>
        <h2 id={`home-${name}`}>{t(`home.${name}`)}</h2>
        <span
          className={`${css.count} figure`}
          data-attention={name === 'needsYou' && items.length > 0 ? '' : undefined}
        >
          {items.length}
        </span>
        {extra}
      </div>
      {items.length > 0 ? list(items) : none && <p className={css.none}>{t(none)}</p>}
    </section>
  );

  return (
    <div className={css.home} ref={ref}>
      <h1 className="visually-hidden">{t('nav.home')}</h1>
      {section('needsYou', waiting, 'home.nothingWaiting', newSession)}
      {section('working', working, 'home.nothingWorking')}
      {recent.length > 0 && section('recent', recent, null)}
    </div>
  );
}

/**
 * Whether the Needs-you rows (`key`, their ids in order) have stood still for `armMs`: deciding
 * one moves the rows under it up, and a session that starts to wait pushes them down, so the
 * second click of a double-click must not land on the next row's Allow. The dialog arms its
 * buttons the same way. Only counts while `active`, a row there to answer.
 */
function useArmed(key: string, armMs: number, active: boolean): boolean {
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

interface AnswerProps {
  session: SessionSummary;
  prompt: OpenPrompt;
  armed: boolean;
  onDecide?: Props['onDecide'];
  onOpen(sessionId: string): void;
}

/**
 * A glassbox run's prompt answered from its row: what it wants as its call card will say it (the
 * whole command in the tooltip), then Deny and Allow, sent through the run that holds it as the
 * dialog sends them; Deny without a reason, which the dialog can give. A question and a plan to
 * approve keep Open: the question's options, and the plan read whole, need the dialog. Answered,
 * the row moves on with the next update, and nothing more can be pressed until then; a failure
 * says why and lets it be sent again.
 */
function Answer({ session: s, prompt, armed, onDecide, onOpen }: AnswerProps) {
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
