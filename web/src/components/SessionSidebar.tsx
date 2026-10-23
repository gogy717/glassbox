import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { SessionSummary } from '../../../src/core/model.js';
import { totalTokens } from '../../../src/core/usage.js';
import { useI18n } from '../i18n';
import { agentName } from '../lib/agent-names';
import { formatCompact, formatRelative } from '../lib/format';
import { groupSessions } from '../lib/sessions';
import css from './SessionSidebar.module.css';
import { LiveDot } from './Status';

interface Props {
  sessions: SessionSummary[];
  selectedId: string | null;
  now: number;
  showProbes?: boolean;
  onSelect(id: string): void;
}

export function SessionSidebar({ sessions, selectedId, now, showProbes, onSelect }: Props) {
  const { t, intl } = useI18n();
  const [query, setQuery] = useState('');
  const groups = useMemo(
    () => groupSessions(sessions, query, { showProbes }),
    [sessions, query, showProbes],
  );
  // Which agent a session belongs to only matters once there is more than one on this machine.
  const multiAgent = useMemo(() => new Set(sessions.map((s) => s.agent)).size > 1, [sessions]);

  return (
    <nav className={css.sidebar} aria-label={t('sidebar.title')}>
      <label className={css.search}>
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={t('sidebar.search')}
          aria-label={t('sidebar.search')}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className={css.list}>
        {groups.length === 0 && (
          <p className={css.empty}>{t(sessions.length ? 'sidebar.noMatch' : 'sidebar.empty')}</p>
        )}
        {groups.map((g) => (
          <ul key={g.project} aria-label={g.project} className={css.group}>
            <li className={css.groupTitle} aria-hidden="true">
              {g.project}
            </li>
            {g.sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={css.item}
                  aria-current={s.id === selectedId ? 'true' : undefined}
                  title={s.cwd ?? undefined}
                  onClick={() => onSelect(s.id)}
                >
                  <span className={css.title}>{s.title ?? t('sidebar.untitled')}</span>
                  <span className={css.meta}>
                    {multiAgent && (
                      <span className={css.agent} data-agent={s.agent}>
                        {agentName(s.agent)}
                      </span>
                    )}
                    <LiveDot state={s.live} />
                    <span>{t(`live.${s.live}`)}</span>
                    <span className={css.sep}>·</span>
                    <span>{formatRelative(s.updatedAt, now, intl)}</span>
                    {s.usage && (
                      <>
                        <span className={css.sep}>·</span>
                        <span className="num">
                          {t('common.tokens', { n: formatCompact(totalTokens(s.usage), intl) })}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}
      </div>
    </nav>
  );
}
