import { memo, useEffect, useMemo, useState } from 'react';
import type { Turn } from '../../../../src/core/model.js';
import { StatusPill, type UiStatus } from '../../components/Status';
import { useApprovalsContext } from '../../data/approvals';
import type { OpenSession } from '../../data/store';
import { useI18n } from '../../i18n';
import { formatClock } from '../../lib/format';
import type { Route } from '../../router';
import {
  callStatus,
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
        return {
          turn,
          title: label(truncatePrompt(turn.prompt)),
          heading: label(turn.prompt.trim()),
          calls: reqs.length,
          tools,
          status: turnStatus(turn, statuses),
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

interface Props {
  items: TurnItem[];
  selectedId: string | null;
  onSelect(turnId: string): void;
}

export const TurnList = memo(function TurnList({ items, selectedId, onSelect }: Props) {
  const { t } = useI18n();
  return (
    <nav className={css.pane} aria-label={t('flow.turns')}>
      <div className={css.head}>
        {t('flow.turns')}
        <span className="num">{items.length}</span>
      </div>
      <ul className={css.list} aria-label={t('flow.turns')}>
        {items.map((it) => (
          <li key={it.turn.id}>
            <button
              type="button"
              className={css.card}
              aria-current={it.turn.id === selectedId ? 'true' : undefined}
              title={it.turn.prompt}
              onClick={() => onSelect(it.turn.id)}
            >
              <span className={css.line}>
                <span className={css.title} data-title>
                  {it.title}
                </span>
                <span className={`${css.time} num`}>{formatClock(it.turn.startedAt)}</span>
              </span>
              {it.turn.origin !== 'human' && it.turn.sender && (
                <span className={css.sender}>{t('flow.from', { sender: it.turn.sender })}</span>
              )}
              <span className={css.line}>
                <span className={css.counts}>
                  {t('flow.callsTools', { calls: it.calls, tools: it.tools })}
                </span>
                <StatusPill status={it.status} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
});
