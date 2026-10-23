import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, Clock3 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelRequest, Turn } from '../../../../src/core/model.js';
import type { LivePartial } from '../../../../src/shared/runs.js';
import { StatusPill } from '../../components/Status';
import type { OpenSession } from '../../data/store';
import { useNow } from '../../data/useNow';
import { useI18n } from '../../i18n';
import { mayStillRun } from '../../lib/agents';
import { formatClock, formatDuration } from '../../lib/format';
import type { Navigate, Route } from '../../router';
import { useUi } from '../../ui';
import { LiveOverlay } from '../composer/LiveOverlay';
import { CallRow } from './CallRow';
import type { CardKey } from './cards';
import css from './FlowView.module.css';
import { requestsOf, toolsOf } from './flow-model';
import { type TurnItem, TurnList, useSelectedTurn, useTurnItems } from './TurnList';
import { TurnTitle } from './TurnTitle';
import { useFollowScroll } from './useFollowScroll';

interface Props {
  open: OpenSession;
  agentId: string;
  route: Route;
  navigate: Navigate;
  /** Streaming reply of a glassbox-owned run on this session (B-lite). */
  live?: LivePartial | null;
}

export function FlowView({ open, agentId, route, navigate, live = null }: Props) {
  const { t } = useI18n();
  const { follow, setFollow } = useUi();

  const items = useTurnItems(open, agentId);
  const current = useSelectedTurn(items, open, agentId, route, follow);
  // An empty view says "yet" only while the agent may still add to it.
  const running = mayStillRun(open, agentId);

  // Stable across renders so memoised rows are not invalidated by a new navigate function.
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const enterAgent = useCallback(
    (id: string) => navRef.current({ agentId: id, turnId: null, requestId: null }),
    [],
  );

  const pickTurn = useCallback(
    (turnId: string) => {
      setFollow(false);
      navigate({ turnId, requestId: null });
    },
    [navigate, setFollow],
  );

  return (
    <div className={css.flow}>
      <TurnList items={items} selectedId={current?.turn.id ?? null} onSelect={pickTurn} />
      <section className={css.main}>
        {current ? (
          <>
            <TurnHeader item={current} />
            <CallList
              key={current.turn.id}
              open={open}
              turn={current.turn}
              focusId={follow ? null : (route.requestId ?? null)}
              live={current === items.at(-1) ? live : null}
              follow={follow}
              onUserScrollAway={() => setFollow(false)}
              onEnterAgent={enterAgent}
            />
          </>
        ) : (
          <p className={css.empty}>{t(running ? 'flow.noTurns' : 'flow.noTurnsDone')}</p>
        )}
        {!follow && (
          <button
            type="button"
            className={css.back}
            onClick={() => {
              setFollow(true);
              navigate({ turnId: null, requestId: null });
            }}
          >
            <ArrowDown size={14} aria-hidden="true" />
            {t('follow.back')}
          </button>
        )}
      </section>
    </div>
  );
}

function TurnHeader({ item }: { item: TurnItem }) {
  const { t } = useI18n();
  const now = useNow();
  const { turn } = item;
  const end = turn.endedAt ? Date.parse(turn.endedAt) : item.status === 'running' ? now : null;
  return (
    <div className={css.turnHeader}>
      <TurnTitle key={turn.id} text={item.heading} className={css.turnTitle} />
      <span className={css.turnMeta}>
        <span>
          <Clock3 size={11} aria-hidden="true" />{' '}
          <span className="num">{formatClock(turn.startedAt)}</span>
        </span>
        <span className="num">
          {formatDuration(end === null ? null : end - Date.parse(turn.startedAt))}
        </span>
        <span>{t('flow.callsTools', { calls: item.calls, tools: item.tools })}</span>
        <StatusPill status={item.status} />
      </span>
    </div>
  );
}

interface ListProps {
  open: OpenSession;
  turn: Turn;
  live: LivePartial | null;
  focusId: string | null;
  follow: boolean;
  onUserScrollAway(): void;
  onEnterAgent(agentId: string): void;
}

const ROW_GAP = 12;

function CallList({
  open,
  turn,
  live,
  focusId,
  follow,
  onUserScrollAway,
  onEnterAgent,
}: ListProps) {
  const { t } = useI18n();
  const parentRef = useRef<HTMLDivElement>(null);
  const calls = useMemo(
    () => requestsOf(open, turn).map((req) => ({ req, tools: toolsOf(open, req) })),
    [open, turn],
  );
  const [selected, setSelected] = useState<{ requestId: string; card: CardKey } | null>(null);
  const awayRef = useRef(onUserScrollAway);
  awayRef.current = onUserScrollAway;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onSelect = useCallback((req: ModelRequest, card: CardKey) => {
    const s = selectedRef.current;
    if (s?.requestId === req.id && s.card === card) setSelected(null);
    else {
      setSelected({ requestId: req.id, card });
      // An open card must not be scrolled away (and unmounted) by follow mode.
      awayRef.current();
    }
  }, []);

  const virtualizer = useVirtualizer({
    count: calls.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 230,
    overscan: 4,
    getItemKey: (i) => calls[i]?.req.id ?? i,
  });

  // Follow: keep the newest call in view as calls arrive.
  useEffect(() => {
    if (follow && calls.length > 0) virtualizer.scrollToIndex(calls.length - 1, { align: 'end' });
  }, [follow, calls.length, virtualizer]);

  // Keep the streaming reply in view while following.
  useEffect(() => {
    const el = parentRef.current;
    if (follow && live && el) el.scrollTop = el.scrollHeight;
  }, [follow, live]);

  const focusIndex = focusId ? calls.findIndex((c) => c.req.id === focusId) : -1;
  useEffect(() => {
    if (focusIndex >= 0) virtualizer.scrollToIndex(focusIndex, { align: 'center' });
  }, [focusIndex, virtualizer]);

  useFollowScroll(parentRef, follow, onUserScrollAway);

  return (
    <div ref={parentRef} className={css.calls}>
      {calls.length === 0 && (
        <p className={css.empty}>
          {t(turn.status === 'running' ? 'flow.noCalls' : 'flow.noCallsDone')}
        </p>
      )}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const call = calls[item.index];
          if (!call) return null;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className={css.slot}
              style={{ transform: `translateY(${item.start}px)`, paddingBottom: ROW_GAP }}
            >
              <CallRow
                req={call.req}
                tools={call.tools}
                open={open}
                focused={call.req.id === focusId}
                selected={selected?.requestId === call.req.id ? selected.card : null}
                onSelect={onSelect}
                onEnterAgent={onEnterAgent}
              />
            </div>
          );
        })}
      </div>
      <LiveOverlay partial={live} />
    </div>
  );
}
