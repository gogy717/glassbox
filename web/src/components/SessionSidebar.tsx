import { Check, Search } from 'lucide-react';
import { type CSSProperties, useMemo, useState } from 'react';
import type { AgentKind, SessionSummary } from '../../../src/core/model.js';
import { totalTokens } from '../../../src/core/usage.js';
import { useI18n } from '../i18n';
import { AGENT_TONES, agentColors, agentName } from '../lib/agent-names';
import { formatCompact, formatRelative } from '../lib/format';
import { groupSessions } from '../lib/sessions';
import { AgentTag } from './AgentTag';
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
  const [only, setOnly] = useState<AgentKind | null>(null);
  // Agents with sessions here, in a fixed order so the chips do not move as sessions update.
  const agents = useMemo(() => {
    const present = new Set(sessions.map((s) => s.agent));
    const known = AGENT_TONES.filter((a) => present.has(a));
    const others = [...present].filter((a) => !(AGENT_TONES as readonly string[]).includes(a));
    return [...known, ...others.sort()];
  }, [sessions]);
  // A filter on an agent whose sessions are all gone shows everything again.
  const filter = only !== null && agents.includes(only) ? only : null;
  const groups = useMemo(
    () =>
      groupSessions(filter ? sessions.filter((s) => s.agent === filter) : sessions, query, {
        showProbes,
      }),
    [sessions, filter, query, showProbes],
  );

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
      {agents.length > 1 && (
        // biome-ignore lint/a11y/useSemanticElements: a row of filter toggles; it is not a form fieldset
        <div className={css.agents} role="group" aria-label={t('sidebar.filterAgents')}>
          {agents.map((a) => {
            const { fg, bg } = agentColors(a);
            return (
              <button
                key={a}
                type="button"
                className={css.chip}
                data-agent={a}
                aria-pressed={filter === a}
                title={t(filter === a ? 'sidebar.allAgents' : 'sidebar.onlyAgent', {
                  agent: agentName(a),
                })}
                style={{ '--tag-fg': fg, '--tag-bg': bg } as CSSProperties}
                onClick={() => setOnly(filter === a ? null : a)}
              >
                {filter === a && <Check size={11} aria-hidden="true" />}
                {agentName(a)}
              </button>
            );
          })}
        </div>
      )}
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
                    <AgentTag kind={s.agent} />
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
