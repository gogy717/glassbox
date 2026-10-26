import { ChevronDown, ChevronRight, Pin, Search } from 'lucide-react';
import { type Ref, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentKind, SessionSummary } from '../../../src/core/model.js';
import { type RovingItemProps, useRovingFocus } from '../data/useRovingFocus';
import { type MessageKey, useI18n } from '../i18n';
import { AGENT_TONES, agentName } from '../lib/agent-names';
import {
  foldClosed,
  groupSessions,
  isListed,
  isRunning,
  LIVE_FILTERS,
  type LiveFilter,
  liveFilterOf,
  type SessionGroup,
  type TimeBucket,
} from '../lib/sessions';
import { DEFAULT_PREFS, type Prefs } from '../prefs';
import { Delayed } from './Delayed';
import { FigureText } from './FigureText';
import { SessionRow } from './SessionRow';
import css from './SessionSidebar.module.css';
import { LiveDot } from './Status';
import { Switch } from './Switch';

/** A group title's and its "N more" row's roving ids: no session id starts with a slash. */
const headId = (key: string) => `/h/${key}`;
const moreId = (key: string) => `/m/${key}`;

interface Props {
  sessions: SessionSummary[];
  selectedId: string | null;
  now: number;
  showProbes?: boolean;
  /** False until the first session list arrives: until then the list says it is connecting. */
  loaded?: boolean;
  /** The sessions whose glassbox run failed, with its error (`failedSessions`). */
  failures?: ReadonlyMap<string, string | null>;
  /** The list's pins, folds and grouping (D, F7), as saved; the list changes them through `onPrefs`. */
  prefs?: Prefs;
  onPrefs?(p: Prefs): void;
  onSelect(id: string): void;
}

const NO_PREFS = () => {};

/** A live-state chip's word: the state's own name. */
const LIVE_WORD: Record<LiveFilter, MessageKey> = {
  running: 'live.busy',
  idle: 'live.idle',
  closed: 'live.closed',
};

/** What the live filter hides, said as what those sessions are. */
const HIDDEN: Record<LiveFilter, MessageKey> = {
  running: 'sidebar.hiddenRunning',
  idle: 'sidebar.hiddenIdle',
  closed: 'sidebar.hiddenClosed',
};

/** A time group's word. */
const TIME_LABEL: Record<TimeBucket, MessageKey> = {
  today: 'sidebar.today',
  yesterday: 'sidebar.yesterday',
  week: 'sidebar.thisWeek',
  earlier: 'sidebar.earlier',
};

export function SessionSidebar({
  sessions,
  selectedId,
  now,
  showProbes,
  loaded = true,
  failures,
  prefs = DEFAULT_PREFS,
  onPrefs = NO_PREFS,
  onSelect,
}: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [onlyAgent, setOnlyAgent] = useState<AgentKind | null>(null);
  const [onlyLive, setOnlyLive] = useState<LiveFilter | null>(null);
  // Chip counts are of every listed session, not of what the other filters leave: chips do not
  // come and go while typing, and the rows always add up.
  const listed = useMemo(
    () => sessions.filter((s) => isListed(s, showProbes)),
    [sessions, showProbes],
  );
  const agentCounts = useMemo(() => {
    const counts = new Map<AgentKind, number>();
    for (const s of listed) counts.set(s.agent, (counts.get(s.agent) ?? 0) + 1);
    // A fixed order, so chips do not move as sessions update.
    const known = AGENT_TONES.filter((a) => counts.has(a));
    const others = [...counts.keys()].filter(
      (a) => !(AGENT_TONES as readonly string[]).includes(a),
    );
    return [...known, ...others.sort()].map((a) => [a, counts.get(a) ?? 0] as const);
  }, [listed]);
  const liveCounts = useMemo(
    () =>
      LIVE_FILTERS.map(
        (f) => [f, listed.filter((s) => liveFilterOf(s) === f).length] as const,
      ).filter(([, n]) => n > 0),
    [listed],
  );
  // A filter whose sessions are all gone is cleared, not left armed behind a pressed "All": the
  // next session in that state or of that agent must not filter the list again unasked. The chip
  // goes with it, so focus on it moves to its row's "All".
  const [refocus, setRefocus] = useState<'agent' | 'live' | null>(null);
  if (onlyAgent !== null && !agentCounts.some(([a]) => a === onlyAgent)) {
    setOnlyAgent(null);
    setRefocus('agent');
  }
  if (onlyLive !== null && !liveCounts.some(([f]) => f === onlyLive)) {
    setOnlyLive(null);
    setRefocus('live');
  }
  const allAgentsRef = useRef<HTMLButtonElement>(null);
  const allStatesRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!refocus) return;
    setRefocus(null);
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (lost) (refocus === 'agent' ? allAgentsRef : allStatesRef).current?.focus();
  }, [refocus]);
  const agent = onlyAgent;
  const live = onlyLive;
  const pinned = prefs.pinned;
  const groupBy = prefs.groupBy;
  const groups = useMemo(
    // The open session keeps its row, so the list never loses what the page shows.
    () =>
      groupSessions(sessions, query, {
        showProbes,
        agent,
        live,
        keep: selectedId,
        pinned,
        groupBy,
        now,
      }),
    [sessions, query, showProbes, agent, live, selectedId, pinned, groupBy, now],
  );
  // Sessions the live filter alone hides, for "5 more are idle or closed".
  const hidden = useMemo(() => {
    if (!live) return 0;
    const shown = new Set(groups.flatMap((g) => g.sessions.map((s) => s.id)));
    return groupSessions(sessions, query, { showProbes, agent }).reduce(
      (n, g) => n + g.sessions.filter((s) => !shown.has(s.id)).length,
      0,
    );
  }, [groups, sessions, query, showProbes, agent, live]);
  // The folded groups, by key. A folded group keeps the open session's row, so the list never
  // loses what the page shows.
  const foldedSet = useMemo(() => new Set(prefs.folded), [prefs.folded]);
  const toggleFold = (key: string) =>
    onPrefs({
      ...prefs,
      folded: foldedSet.has(key) ? prefs.folded.filter((k) => k !== key) : [...prefs.folded, key],
    });
  // The rest of a group's closed sessions wait behind "N more", unfolded per group for this page
  // only. Not under a search or the Closed filter, which ask for them, and never the pins.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const capped = !query.trim() && live !== 'closed';
  const visible = useMemo(
    () =>
      groups.map((g) => {
        const none: SessionSummary[] = [];
        if (foldedSet.has(g.key))
          return { g, rows: g.sessions.filter((s) => s.id === selectedId), more: none };
        if (!capped || g.kind === 'pinned' || unfolded.has(g.key))
          return { g, rows: g.sessions, more: none };
        const { shown, more } = foldClosed(g.sessions, selectedId);
        return { g, rows: shown, more };
      }),
    [groups, foldedSet, selectedId, capped, unfolded],
  );
  // One tab stop for the whole list; the arrow keys move between the rows, the group titles and
  // the "N more" rows in their order, across projects. The rows come first here, so Tab enters
  // at a row.
  const listRef = useRef<HTMLDivElement>(null);
  const ids = useMemo(
    () => [
      ...visible.flatMap(({ rows }) => rows.map((s) => s.id)),
      ...visible.map(({ g }) => headId(g.key)),
      ...visible.filter(({ more }) => more.length > 0).map(({ g }) => moreId(g.key)),
    ],
    [visible],
  );
  const roving = useRovingFocus(listRef, ids, selectedId);
  const uid = useId();
  // Focus follows a row that a change lists elsewhere (a pin moves it to the Pinned group).
  const [refocusRow, setRefocusRow] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (refocusRow === null) return;
    setRefocusRow(null);
    [...(listRef.current?.querySelectorAll<HTMLElement>('[data-roving]') ?? [])]
      .find((el) => el.dataset.roving === refocusRow)
      ?.focus();
  }, [refocusRow]);
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const togglePin = (id: string) => {
    onPrefs({
      ...prefs,
      pinned: pinnedSet.has(id) ? pinned.filter((p) => p !== id) : [...pinned, id],
    });
    setRefocusRow(id);
  };
  // "N more" pressed: the rest of the group shows, and focus moves on to the first row of it.
  const unfold = (key: string, first: SessionSummary) => {
    setUnfolded((u) => new Set(u).add(key));
    setRefocusRow(first.id);
  };
  // A row's keys: P alone pins or unpins it; the rest move between the rows.
  const rowProps = (id: string): RovingItemProps => {
    const props = roving(id);
    return {
      ...props,
      onKeyDown: (e) => {
        if ((e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          togglePin(id);
        } else props.onKeyDown(e);
      },
    };
  };
  // A project group reads as its name; the pinned and time groups in the UI language.
  const label = (g: SessionGroup) =>
    g.kind === 'project'
      ? g.key
      : g.kind === 'pinned'
        ? t('sidebar.pinned')
        : t(TIME_LABEL[g.bucket]);

  return (
    <nav className={css.sidebar} aria-label={t('sidebar.title')}>
      <div className={css.head}>
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
        {/* One choice is no choice, unless a filter on it is still armed: then "All" clears it. */}
        {(agentCounts.length > 1 || agent !== null) && (
          // biome-ignore lint/a11y/useSemanticElements: a row of filter toggles, not a form fieldset
          <div className={css.chips} role="group" aria-label={t('sidebar.filterAgents')}>
            <Chip
              ref={allAgentsRef}
              pressed={agent === null}
              count={listed.length}
              title={t('sidebar.allAgents')}
              onClick={() => setOnlyAgent(null)}
            >
              {t('sidebar.all')}
            </Chip>
            {agentCounts.map(([a, n]) => (
              <Chip
                key={a}
                pressed={agent === a}
                count={n}
                title={t(agent === a ? 'sidebar.allAgents' : 'sidebar.onlyAgent', {
                  agent: agentName(a),
                })}
                onClick={() => setOnlyAgent(agent === a ? null : a)}
              >
                {agentName(a)}
              </Chip>
            ))}
          </div>
        )}
        {(liveCounts.length > 1 || live !== null) && (
          // biome-ignore lint/a11y/useSemanticElements: a row of filter toggles, not a form fieldset
          <div className={css.chips} role="group" aria-label={t('sidebar.filterStates')}>
            <Chip
              ref={allStatesRef}
              pressed={live === null}
              title={t('sidebar.allStates')}
              onClick={() => setOnlyLive(null)}
            >
              {t('sidebar.all')}
            </Chip>
            {liveCounts.map(([f, n]) => (
              <Chip
                key={f}
                pressed={live === f}
                count={n}
                title={f === 'running' ? t('sidebar.runningIncludesWaiting') : undefined}
                onClick={() => setOnlyLive(live === f ? null : f)}
              >
                {t(LIVE_WORD[f])}
              </Chip>
            ))}
          </div>
        )}
        {/* The switch carries the name; the word beside it is for the eye. */}
        <div className={css.groupBy}>
          <span aria-hidden="true">{t('sidebar.groupBy')}</span>
          <Switch
            size="small"
            label={t('sidebar.groupBy')}
            value={groupBy}
            onChange={(by) => onPrefs({ ...prefs, groupBy: by })}
            options={[
              { value: 'project', label: t('sidebar.byProject') },
              { value: 'time', label: t('sidebar.byTime') },
            ]}
          />
        </div>
      </div>
      <div ref={listRef} className={css.list}>
        {groups.length === 0 &&
          (sessions.length || loaded ? (
            <p className={css.empty}>{t(sessions.length ? 'sidebar.noMatch' : 'sidebar.empty')}</p>
          ) : (
            <Delayed>
              <p className={css.empty}>{t('sidebar.connecting')}</p>
            </Delayed>
          ))}
        {visible.map(({ g, rows, more }, i) => {
          const name = label(g);
          const folded = foldedSet.has(g.key);
          const listId = `${uid}-${i}`;
          const busy = folded ? g.sessions.filter((s) => s.live === 'busy').length : 0;
          const waiting = folded ? g.sessions.filter((s) => s.live === 'waiting').length : 0;
          return (
            <div key={g.key} className={css.group}>
              <button
                type="button"
                className={`${css.groupTitle} section-label`}
                aria-expanded={!folded}
                aria-controls={rows.length > 0 ? listId : undefined}
                title={g.kind === 'project' ? (g.cwd ?? undefined) : undefined}
                {...roving(headId(g.key))}
                onClick={() => toggleFold(g.key)}
              >
                {folded ? (
                  <ChevronRight size={12} aria-hidden="true" />
                ) : (
                  <ChevronDown size={12} aria-hidden="true" />
                )}
                <span className={css.groupName}>{name}</span>
                {/* Folded: how many, and a dot per running or waiting session, so nothing urgent
                    hides. The spaces are for the title's spoken name. */}
                {folded && (
                  <>
                    {' '}
                    <span className={`${css.groupCount} figure`} aria-hidden="true">
                      {g.sessions.length}
                    </span>
                    <span className="visually-hidden">
                      {t('sidebar.foldedCount', { n: g.sessions.length })}
                    </span>
                    {busy + waiting > 0 && (
                      <>
                        {' '}
                        <span className={css.groupDots} aria-hidden="true">
                          {g.sessions.filter(isRunning).map((s) => (
                            <LiveDot key={s.id} state={s.live} />
                          ))}
                        </span>
                        <span className="visually-hidden">
                          {[
                            busy > 0 && t('sidebar.foldedRunning', { n: busy }),
                            waiting > 0 && t('sidebar.foldedWaiting', { n: waiting }),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </>
                    )}
                  </>
                )}
              </button>
              {rows.length > 0 && (
                <ul id={listId} aria-label={name} className={css.rows}>
                  {rows.map((s) => (
                    <li key={s.id} className={css.item}>
                      <SessionRow
                        session={s}
                        selected={s.id === selectedId}
                        now={now}
                        failure={failures?.get(s.id)}
                        roving={rowProps(s.id)}
                        onSelect={onSelect}
                      />
                      {/* Named Pin whether pressed or not: pressed says it is pinned. Not a tab
                          stop: the rows are one, and P on a row does the same. */}
                      <button
                        type="button"
                        className={css.pin}
                        tabIndex={-1}
                        aria-pressed={pinnedSet.has(s.id)}
                        aria-label={t('sidebar.pin')}
                        title={`${t(pinnedSet.has(s.id) ? 'sidebar.unpin' : 'sidebar.pin')} · P`}
                        onClick={() => togglePin(s.id)}
                      >
                        <Pin size={12} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {more[0] && (
                <button
                  type="button"
                  className={css.more}
                  {...roving(moreId(g.key))}
                  onClick={() => unfold(g.key, more[0] as SessionSummary)}
                >
                  <FigureText k="sidebar.more" params={{ n: more.length }} figures={['n']} />
                </button>
              )}
            </div>
          );
        })}
        {live && hidden > 0 && (
          <p className={css.hidden}>
            {t(HIDDEN[live], { n: hidden })}{' '}
            <button type="button" className={css.showAll} onClick={() => setOnlyLive(null)}>
              {t('sidebar.showAll')}
            </button>
          </p>
        )}
      </div>
    </nav>
  );
}

/** A text toggle: pressed is an ink border; the count in the mono face. */
function Chip({
  ref,
  pressed,
  count,
  title,
  onClick,
  children,
}: {
  ref?: Ref<HTMLButtonElement>;
  pressed: boolean;
  count?: number;
  title?: string;
  onClick(): void;
  children: string;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className={css.chip}
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
    >
      {children}
      {/* Spoken as "Grok 1"; the gap on screen is the chip's. */}
      {count !== undefined && <span className={`${css.count} figure`}> {count}</span>}
    </button>
  );
}
