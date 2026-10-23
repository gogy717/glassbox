import { Search } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Turn } from '../../../../src/core/model.js';
import { FigureText } from '../../components/FigureText';
import { StatusMark, type UiStatus } from '../../components/Status';
import { useApprovalsContext } from '../../data/approvals';
import { useSessionAgentKind } from '../../data/session-agent';
import type { OpenSession } from '../../data/store';
import { useRovingFocus } from '../../data/useRovingFocus';
import { useI18n } from '../../i18n';
import { formatClock } from '../../lib/format';
import type { Route } from '../../router';
import {
  callStatus,
  isLocalCommand,
  isOutsideTurn,
  requestsOf,
  toolsOf,
  truncatePrompt,
  turnStatus,
  turnsOf,
} from './flow-model';
import css from './TurnList.module.css';

export interface TurnItem {
  turn: Turn;
  /** What it is called: "Conversation 2", or "Calls outside conversations". */
  label: string;
  /** For the turn list: one line, the prompt shortened, without the label. */
  title: string;
  /** For the open turn's heading: the whole prompt, line breaks kept, without the label. */
  prompt: string;
  calls: number;
  tools: number;
  status: UiStatus;
  /** A local slash command (no model call): listed compactly. */
  command: boolean;
}

/** The agent's turns with display titles, counts and statuses (shared by the flow and steps tabs). */
export function useTurnItems(open: OpenSession, agentId: string): TurnItem[] {
  const { t } = useI18n();
  const approvals = useApprovalsContext();
  const agent = useSessionAgentKind();
  return useMemo(
    () =>
      turnsOf(open, agentId).map((turn) => {
        const reqs = requestsOf(open, turn);
        let tools = 0;
        const statuses = reqs.map((r) => {
          const ts = toolsOf(open, r);
          tools += ts.length;
          return callStatus(r, ts, approvals);
        });
        const label = turnLabel(turn, t);
        const prompt = turnPrompt(turn, t);
        const status = turnStatus(turn, statuses);
        return {
          turn,
          label,
          title: prompt ? truncatePrompt(prompt) : label,
          prompt: prompt || label,
          calls: reqs.length,
          tools,
          status,
          command: isLocalCommand(turn, reqs.length, status, agent),
        };
      }),
    [open, agentId, t, approvals, agent],
  );
}

type Translate = ReturnType<typeof useI18n>['t'];

/** What a turn is called: its number, unless it is the bucket of calls outside any turn. */
function turnLabel(turn: Turn, t: Translate): string {
  if (isOutsideTurn(turn)) return t('flow.outsideTurns');
  return t('flow.turnLabel', { n: turn.index });
}

/** What a turn asked, in a sentence of its own; empty when it asked nothing that can be shown. */
function turnPrompt(turn: Turn, t: Translate): string {
  if (isOutsideTurn(turn)) return '';
  if (turn.origin === 'task-notification') return t('flow.taskNotification');
  return turn.prompt.trim();
}

/**
 * Follow mode shows the newest turn; otherwise the turn in the URL, the linked request's, or the
 * turn that was on screen when follow paused (`stickyId`).
 */
export function selectTurn(
  items: TurnItem[],
  open: OpenSession,
  agentId: string,
  route: Route,
  follow: boolean,
  stickyId: string | null = null,
  latest: TurnItem | undefined = items.at(-1),
): TurnItem | undefined {
  const linked = route.requestId ? open.requests.get(route.requestId) : undefined;
  const pinnedId = follow ? null : (route.turnId ?? linked?.turnId ?? stickyId);
  return items.find((it) => it.turn.id === pinnedId && it.turn.agentId === agentId) ?? latest;
}

/**
 * `selectTurn` plus memory: when follow pauses (scrolling up, opening a card) the turn on screen
 * stays put even if a newer turn arrives, so the reader keeps their place. `latest` is the turn
 * follow shows: the newest, or the newest that passes the list's filter.
 */
export function useSelectedTurn(
  items: TurnItem[],
  open: OpenSession,
  agentId: string,
  route: Route,
  follow: boolean,
  latest: TurnItem | undefined = items.at(-1),
): TurnItem | undefined {
  const [sticky, setSticky] = useState<{ agentId: string; turnId: string } | null>(null);
  const stickyId = sticky?.agentId === agentId ? sticky.turnId : null;
  const current = selectTurn(items, open, agentId, route, follow, stickyId, latest);
  const currentId = current?.turn.id ?? null;
  useEffect(() => {
    if (follow || !currentId) setSticky(null);
    else setSticky((s) => (s && s.agentId === agentId ? s : { agentId, turnId: currentId }));
  }, [follow, currentId, agentId]);
  return current;
}

/** Space kept between a revealed card and the list's edge (the list's own padding). */
const EDGE_PX = 10;

/** Scrolls `list` itself, never an ancestor, just enough to show `el`, on either axis. */
function reveal(list: HTMLElement, el: HTMLElement): void {
  const l = list.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < l.top) list.scrollTop -= l.top - r.top + EDGE_PX;
  else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom + EDGE_PX;
  if (r.left < l.left) list.scrollLeft -= l.left - r.left + EDGE_PX;
  else if (r.right > l.right) list.scrollLeft += r.right - l.right + EDGE_PX;
}

/**
 * The turns whose heading matches `query` (case-insensitive): the label and the prompt the row
 * shows, never tool output. All of them for an empty query.
 */
export function filterTurns(items: TurnItem[], query: string): TurnItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => `${it.label} ${it.prompt}`.toLowerCase().includes(q));
}

interface Props {
  /** Chronological, as `useTurnItems` returns them. */
  items: TurnItem[];
  selectedId: string | null;
  onSelect(turnId: string): void;
  /** With `onQuery`, a filter field above the list (`filterTurns`). */
  query?: string;
  onQuery?(query: string): void;
}

/**
 * The agent's turns, newest first: the turn being followed, or the one that just arrived, is on
 * top (on the left in the narrow, horizontal layout). Numbers stay chronological, and the DOM is
 * in display order so keyboard order matches what is seen.
 */
export const TurnList = memo(function TurnList({
  items,
  selectedId,
  onSelect,
  query = '',
  onQuery,
}: Props) {
  const { t } = useI18n();
  const listRef = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => filterTurns(items, query), [items, query]);
  const newestFirst = useMemo(() => [...shown].reverse(), [shown]);
  const ids = useMemo(() => newestFirst.map((it) => it.turn.id), [newestFirst]);
  // One tab stop for the whole list; the arrow keys move between turns.
  const roving = useRovingFocus(listRef, ids, selectedId);

  // Follow moves the selection to each new turn and a link may select an old one: keep it in view.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !selectedId) return;
    for (const li of list.children)
      if (li instanceof HTMLElement && li.dataset.turn === selectedId) reveal(list, li);
  }, [selectedId]);

  return (
    <nav className={css.pane} aria-label={t('flow.turns')}>
      <div className={css.head}>
        {t('flow.turns')}
        <span>
          {shown.length === items.length ? (
            <span className="figure">{items.length}</span>
          ) : (
            <FigureText k="flow.turnsShown" params={{ n: shown.length, total: items.length }} />
          )}
        </span>
      </div>
      {onQuery && (
        <label className={css.filter}>
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={t('flow.filterTurns')}
            aria-label={t('flow.filterTurns')}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                onQuery('');
              }
            }}
          />
        </label>
      )}
      {newestFirst.length === 0 && items.length > 0 && (
        <p className={css.none}>{t('flow.noTurnMatch')}</p>
      )}
      <ul
        ref={listRef}
        className={css.list}
        aria-label={t('flow.turns')}
        hidden={newestFirst.length === 0 && items.length > 0}
      >
        {newestFirst.map((it) => {
          const clock = formatClock(it.turn.startedAt);
          // Dense list: complete and failed are their glyph alone; the dot states keep their
          // word, as a dot would differ by colour only.
          const mark = <StatusMark status={it.status} compact />;
          return (
            <li key={it.turn.id} data-turn={it.turn.id}>
              <button
                type="button"
                className={css.row}
                {...roving(it.turn.id)}
                aria-current={it.turn.id === selectedId ? 'true' : undefined}
                data-command={it.command || undefined}
                title={it.turn.prompt}
                onClick={() => onSelect(it.turn.id)}
              >
                {/* The number column says "Conversation N" on screen; screen readers hear the words. */}
                {!it.command && it.title !== it.label && (
                  <span className="visually-hidden">{`${it.label} `}</span>
                )}
                <span className={`${css.num} figure`} aria-hidden="true">
                  {it.command || isOutsideTurn(it.turn) ? '' : it.turn.index}
                </span>
                {/* Not a conversation, so not numbered like one: the command says what it was. */}
                <span className={css.title} data-title>
                  {it.command ? it.turn.prompt.trim() : it.title}
                </span>
                <span className={`${css.clock} figure`}>{clock}</span>
                {it.command ? (
                  <>
                    <span className={css.command}>{t('flow.localCommand')}</span>
                    {/* Part of the row's text, so screen readers read it; shown on hover and focus. */}
                    <span className={css.hint}>{t('flow.localCommandHint')}</span>
                  </>
                ) : (
                  <>
                    <span className={css.markTop}>{mark}</span>
                    {it.turn.origin !== 'human' && it.turn.sender && (
                      <span className={css.sender}>
                        {t('flow.from', { sender: it.turn.sender })}
                      </span>
                    )}
                    <span className={css.sub}>
                      <span className={`${css.subClock} figure`}>{clock}</span>
                      <span className={css.counts}>
                        <FigureText
                          k="flow.callsToolsShort"
                          params={{ calls: it.calls, tools: it.tools }}
                        />
                      </span>
                      <span className={css.markSub}>{mark}</span>
                    </span>
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
});
