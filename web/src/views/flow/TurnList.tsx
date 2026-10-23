import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Turn } from '../../../../src/core/model.js';
import { StatusPill, type UiStatus } from '../../components/Status';
import { useApprovalsContext } from '../../data/approvals';
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
  /** For the turn list: one line, the prompt shortened. */
  title: string;
  /** For the open turn's heading: the whole prompt, line breaks kept. */
  heading: string;
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
        const label = (prompt: string) =>
          isOutsideTurn(turn)
            ? t('flow.outsideTurns')
            : turn.origin === 'task-notification'
              ? t('flow.turnTitle', { n: turn.index, prompt: t('flow.taskNotification') })
              : prompt
                ? t('flow.turnTitle', { n: turn.index, prompt })
                : t('flow.turnFallback', { n: turn.index });
        const status = turnStatus(turn, statuses);
        return {
          turn,
          title: label(truncatePrompt(turn.prompt)),
          heading: label(turn.prompt.trim()),
          calls: reqs.length,
          tools,
          status,
          command: isLocalCommand(turn, reqs.length, status),
        };
      }),
    [open, agentId, t, approvals],
  );
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
): TurnItem | undefined {
  const linked = route.requestId ? open.requests.get(route.requestId) : undefined;
  const pinnedId = follow ? null : (route.turnId ?? linked?.turnId ?? stickyId);
  return items.find((it) => it.turn.id === pinnedId && it.turn.agentId === agentId) ?? items.at(-1);
}

/**
 * `selectTurn` plus memory: when follow pauses (scrolling up, opening a card) the turn on screen
 * stays put even if a newer turn arrives, so the reader keeps their place.
 */
export function useSelectedTurn(
  items: TurnItem[],
  open: OpenSession,
  agentId: string,
  route: Route,
  follow: boolean,
): TurnItem | undefined {
  const [sticky, setSticky] = useState<{ agentId: string; turnId: string } | null>(null);
  const stickyId = sticky?.agentId === agentId ? sticky.turnId : null;
  const current = selectTurn(items, open, agentId, route, follow, stickyId);
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

interface Props {
  /** Chronological, as `useTurnItems` returns them. */
  items: TurnItem[];
  selectedId: string | null;
  onSelect(turnId: string): void;
}

/**
 * The agent's turns, newest first: the turn being followed, or the one that just arrived, is on
 * top (on the left in the narrow, horizontal layout). Numbers stay chronological, and the DOM is
 * in display order so keyboard order matches what is seen.
 */
export const TurnList = memo(function TurnList({ items, selectedId, onSelect }: Props) {
  const { t } = useI18n();
  const listRef = useRef<HTMLUListElement>(null);
  const newestFirst = useMemo(() => [...items].reverse(), [items]);
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
        <span className="num">{items.length}</span>
      </div>
      <ul ref={listRef} className={css.list} aria-label={t('flow.turns')}>
        {newestFirst.map((it) => (
          <li key={it.turn.id} data-turn={it.turn.id}>
            <button
              type="button"
              className={css.card}
              {...roving(it.turn.id)}
              aria-current={it.turn.id === selectedId ? 'true' : undefined}
              data-command={it.command || undefined}
              title={it.turn.prompt}
              onClick={() => onSelect(it.turn.id)}
            >
              <span className={css.line}>
                {/* Not a conversation, so not numbered like one: the command says what it was. */}
                <span className={css.title} data-title>
                  {it.command ? it.turn.prompt.trim() : it.title}
                </span>
                {it.command && (
                  <span className={css.command} title={t('flow.localCommandHint')}>
                    {t('flow.localCommand')}
                  </span>
                )}
                <span className={`${css.time} num`}>{formatClock(it.turn.startedAt)}</span>
              </span>
              {/* A local command has no calls or status to show: one line is enough. */}
              {!it.command && it.turn.origin !== 'human' && it.turn.sender && (
                <span className={css.sender}>{t('flow.from', { sender: it.turn.sender })}</span>
              )}
              {!it.command && (
                <span className={css.line}>
                  <span className={css.counts}>
                    {t('flow.callsTools', { calls: it.calls, tools: it.tools })}
                  </span>
                  <StatusPill status={it.status} />
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
});
