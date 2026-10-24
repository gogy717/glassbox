import { ArrowRight, Plus } from 'lucide-react';
import { useMemo, useRef } from 'react';
import type { AgentKind, SessionSummary } from '../../../src/core/model.js';
import { AgentTag } from '../components/AgentTag';
import { FigureText } from '../components/FigureText';
import { SessionRow } from '../components/SessionRow';
import { useRovingFocus } from '../data/useRovingFocus';
import { useI18n } from '../i18n';
import { groupSessions, isListed, liveFilterOf, type SessionGroup } from '../lib/sessions';
import css from './Home.module.css';

interface Props {
  sessions: SessionSummary[];
  loaded: boolean;
  now: number;
  showProbes: boolean;
  /** The sessions whose glassbox run failed, with its error (`failedSessions`). */
  failures: ReadonlyMap<string, string | null>;
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
 * The screen before a session is open: what is running right now, then what ran recently, each
 * grouped by project, as rows of the sidebar's kind at card density. The rows are one tab stop;
 * the arrow keys move between them and Enter opens one. With no sessions, where glassbox looks.
 */
export function Home({ sessions, loaded, now, showProbes, failures, onOpen, onNewSession }: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const visible = useMemo(
    () => sessions.filter((s) => isListed(s, showProbes)),
    [sessions, showProbes],
  );
  const running = useMemo(
    () => groupSessions(visible, '', { showProbes: true, live: 'running' }),
    [visible],
  );
  const recent = useMemo(
    () =>
      groupSessions(
        visible
          .filter((s) => liveFilterOf(s) !== 'running')
          .sort(newestFirst)
          .slice(0, RECENT),
        '',
        { showProbes: true },
      ),
    [visible],
  );
  const rows = [...running, ...recent].flatMap((g) => g.sessions);
  const roving = useRovingFocus(
    ref,
    rows.map((s) => s.id),
    null,
  );

  if (!loaded) return <p className={css.placeholder}>{t('home.connecting')}</p>;

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
          <button type="button" className={css.newSession} onClick={onNewSession}>
            <Plus size={14} aria-hidden="true" />
            {t('composer.newSession')}
          </button>
        </section>
      </div>
    );

  const count = (groups: SessionGroup[]) => groups.reduce((n, g) => n + g.sessions.length, 0);
  const latest = rows[0];
  const openLatest = latest && (
    <button type="button" className={css.openLatest} onClick={() => onOpen(latest.id)}>
      {t('home.openLatest')}
      <ArrowRight size={14} aria-hidden="true" />
    </button>
  );
  const groups = (list: SessionGroup[]) =>
    list.map((g) => (
      <div key={g.project} className={css.group}>
        <h3 className={`section-label ${css.project}`}>{g.project}</h3>
        <ul className={css.rows}>
          {g.sessions.map((s) => (
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
      </div>
    ));

  return (
    <div className={css.home} ref={ref}>
      <h1 className="visually-hidden">{t('app.emptyTitle')}</h1>
      {running.length > 0 && (
        <section className={css.section} aria-labelledby="home-running" data-section="running">
          <div className={css.header}>
            <h2 id="home-running">{t('home.running')}</h2>
            <span className={css.count}>
              <FigureText
                k="home.runningOf"
                params={{ n: count(running), m: visible.length }}
                figures={['n', 'm']}
              />
            </span>
            {openLatest}
          </div>
          {groups(running)}
        </section>
      )}
      {recent.length > 0 && (
        <section className={css.section} aria-labelledby="home-recent" data-section="recent">
          <div className={css.header}>
            <h2 id="home-recent">{t('home.recent')}</h2>
            <span className={`${css.count} figure`}>{count(recent)}</span>
            {running.length === 0 && openLatest}
          </div>
          {groups(recent)}
        </section>
      )}
    </div>
  );
}
