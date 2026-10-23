import { Check, Search } from 'lucide-react';
import { type CSSProperties, useMemo, useRef, useState } from 'react';
import type { AgentKind, SessionSummary } from '../../../src/core/model.js';
import { totalTokens } from '../../../src/core/usage.js';
import { type RovingItemProps, useRovingFocus } from '../data/useRovingFocus';
import { useI18n } from '../i18n';
import { AGENT_TONES, agentColors, agentName } from '../lib/agent-names';
import { formatCompact, formatRelative } from '../lib/format';
import { groupSessions, isListed } from '../lib/sessions';
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
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [only, setOnly] = useState<AgentKind | null>(null);
  // Agents with sessions in the list (probes count only when shown), in a fixed order so the
  // chips do not move as sessions update.
  const agents = useMemo(() => {
    const present = new Set(sessions.filter((s) => isListed(s, showProbes)).map((s) => s.agent));
    const known = AGENT_TONES.filter((a) => present.has(a));
    const others = [...present].filter((a) => !(AGENT_TONES as readonly string[]).includes(a));
    return [...known, ...others.sort()];
  }, [sessions, showProbes]);
  // A filter on an agent whose sessions are all gone shows everything again.
  const filter = only !== null && agents.includes(only) ? only : null;
  const groups = useMemo(
    () =>
      groupSessions(
        // The open session keeps its row, so the list never loses what the page shows.
        filter ? sessions.filter((s) => s.agent === filter || s.id === selectedId) : sessions,
        query,
        { showProbes },
      ),
    [sessions, filter, selectedId, query, showProbes],
  );
  // One tab stop for the whole list; the arrow keys move between sessions, across projects.
  const listRef = useRef<HTMLDivElement>(null);
  const ids = useMemo(() => groups.flatMap((g) => g.sessions.map((s) => s.id)), [groups]);
  const roving = useRovingFocus(listRef, ids, selectedId);

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
      <div ref={listRef} className={css.list}>
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
                <SessionRow
                  session={s}
                  selected={s.id === selectedId}
                  now={now}
                  roving={roving(s.id)}
                  onSelect={onSelect}
                />
              </li>
            ))}
          </ul>
        ))}
      </div>
    </nav>
  );
}

function SessionRow({
  session: s,
  selected,
  now,
  roving,
  onSelect,
}: {
  session: SessionSummary;
  selected: boolean;
  now: number;
  roving: RovingItemProps;
  onSelect(id: string): void;
}) {
  const { t, intl } = useI18n();
  // Whether the row cut its text short when the pointer arrived: only then does the tooltip
  // repeat the row's text (whole), so a screen reader does not hear it twice.
  const [clipped, setClipped] = useState(false);
  const title = s.title ?? t('sidebar.untitled');
  const live = t(`live.${s.live}`);
  const when = formatRelative(s.updatedAt, now, intl);
  const tokens = s.usage
    ? t('common.tokens', { n: formatCompact(totalTokens(s.usage), intl) })
    : null;
  const tip = clipped
    ? [title, [agentName(s.agent), live, when, tokens].filter(Boolean).join(' · '), s.cwd]
        .filter(Boolean)
        .join('\n')
    : (s.cwd ?? undefined);
  return (
    <button
      type="button"
      className={css.item}
      {...roving}
      aria-current={selected ? 'true' : undefined}
      title={tip}
      onPointerEnter={(e) =>
        setClipped(
          [...e.currentTarget.querySelectorAll<HTMLElement>('[data-clip]')].some(
            (el) => el.scrollWidth > el.clientWidth,
          ),
        )
      }
      onClick={() => onSelect(s.id)}
    >
      <span className={css.title} data-clip>
        {title}
      </span>
      <span className={css.meta}>
        <AgentTag kind={s.agent} />
        <LiveDot state={s.live} />
        <span className={css.state}>{live}</span>
        <span className={css.when} data-clip>
          <span className={css.sep}>·</span> {when}
          {tokens && (
            <>
              {' '}
              <span className={css.sep}>·</span> <span className="num">{tokens}</span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}
