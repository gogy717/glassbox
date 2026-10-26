import { Plus } from 'lucide-react';
import { type ReactNode, useMemo, useRef } from 'react';
import type { AgentKind, SessionSummary } from '../../../src/core/model.js';
import { AgentTag } from '../components/AgentTag';
import { Delayed } from '../components/Delayed';
import { SessionRow } from '../components/SessionRow';
import { useRovingFocus } from '../data/useRovingFocus';
import { type MessageKey, useI18n } from '../i18n';
import { isListed } from '../lib/sessions';
import { longestWaitFirst } from '../lib/waiting';
import css from './Home.module.css';

interface Props {
  sessions: SessionSummary[];
  loaded: boolean;
  now: number;
  showProbes: boolean;
  /** The sessions whose glassbox run failed, with its error (`failedSessions`). */
  failures: ReadonlyMap<string, string | null>;
  /** The session open last: back on Home, its row keeps the tab stop. */
  lastOpened?: string | null;
  onOpen(sessionId: string): void;
  onNewSession(): void;
}

const RECENT = 6;
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
  lastOpened = null,
  onOpen,
  onNewSession,
}: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const visible = useMemo(
    () => sessions.filter((s) => isListed(s, showProbes)),
    [sessions, showProbes],
  );
  const needsYou = useMemo(
    () => visible.filter((s) => s.live === 'waiting').sort(longestWaitFirst),
    [visible],
  );
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
  const rows = [...needsYou, ...working, ...recent];
  const roving = useRovingFocus(
    ref,
    rows.map((s) => s.id),
    lastOpened,
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
      {section('needsYou', needsYou, 'home.nothingWaiting', newSession)}
      {section('working', working, 'home.nothingWorking')}
      {recent.length > 0 && section('recent', recent, null)}
    </div>
  );
}
