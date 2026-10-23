import { ArrowRight, Plus } from 'lucide-react';
import { useMemo } from 'react';
import type { SessionSummary } from '../../../src/core/model.js';
import { LiveDot } from '../components/Status';
import { useI18n } from '../i18n';
import { formatRelative } from '../lib/format';
import css from './Home.module.css';

interface Props {
  sessions: SessionSummary[];
  loaded: boolean;
  now: number;
  showProbes: boolean;
  onOpen(sessionId: string): void;
  onNewSession(): void;
}

const RECENT = 6;
const isRunning = (s: SessionSummary) => s.live === 'busy' || s.live === 'waiting';
const newestFirst = (a: SessionSummary, b: SessionSummary) =>
  b.updatedAt.localeCompare(a.updatedAt);

/** The screen before a session is open: first-run help, or what is running right now. */
export function Home({ sessions, loaded, now, showProbes, onOpen, onNewSession }: Props) {
  const { t, intl } = useI18n();
  const visible = useMemo(
    () => sessions.filter((s) => showProbes || !s.tags?.includes('probe')).sort(newestFirst),
    [sessions, showProbes],
  );
  const running = visible.filter(isRunning);
  const recent = visible.filter((s) => !isRunning(s)).slice(0, RECENT);
  const latest = running[0] ?? visible[0];

  if (!loaded) return <p className={css.placeholder}>{t('home.connecting')}</p>;

  if (visible.length === 0)
    return (
      <div className={css.home}>
        <h1>{t('home.emptyTitle')}</h1>
        <p>{t('home.emptyBody1')}</p>
        <p>{t('home.emptyBody2')}</p>
        <button type="button" className={css.primary} onClick={onNewSession}>
          <Plus size={14} aria-hidden="true" />
          {t('composer.newSession')}
        </button>
      </div>
    );

  const card = (s: SessionSummary) => (
    <li key={s.id}>
      <button type="button" className={css.card} onClick={() => onOpen(s.id)}>
        <span className={css.title}>{s.title ?? t('sidebar.untitled')}</span>
        <span className={css.meta}>
          <LiveDot state={s.live} />
          {t(`live.${s.live}`)} · {s.project} · {formatRelative(s.updatedAt, now, intl)}
        </span>
      </button>
    </li>
  );

  return (
    <div className={css.home}>
      <h1>{t('app.emptyTitle')}</h1>
      {latest && (
        <button type="button" className={css.primary} onClick={() => onOpen(latest.id)}>
          {t('home.openLatest')}
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      )}
      {running.length > 0 && (
        <section aria-labelledby="home-running" className={css.section}>
          <h2 id="home-running">{t('home.running')}</h2>
          <ul>{running.map(card)}</ul>
        </section>
      )}
      {recent.length > 0 && (
        <section aria-labelledby="home-recent" className={css.section}>
          <h2 id="home-recent">{t('home.recent')}</h2>
          <ul>{recent.map(card)}</ul>
        </section>
      )}
    </div>
  );
}
