import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelRequest, ToolCall, Turn } from '../../../../src/core/model.js';
import type { LivePartial } from '../../../../src/shared/runs.js';
import type { OpenSession } from '../../data/store';
import { useDebounced } from '../../data/useDebounced';
import { useI18n } from '../../i18n';
import { mayStillRun } from '../../lib/agents';
import type { Navigate, Route } from '../../router';
import { useUi } from '../../ui';
import { LiveOverlay } from '../composer/LiveOverlay';
import { CallRow } from './CallRow';
import { CopyMarkdown } from './CopyMarkdown';
import type { CardKey } from './cards';
import css from './FlowView.module.css';
import { FollowPausedBar } from './FollowPausedBar';
import { requestsOf, toolsOf } from './flow-model';
import { type SearchHit, searchable, searchSession } from './search';
import { type SearchScope, useSearchPrefs } from './search-prefs';
import { TurnHeader } from './TurnHeader';
import { newestMatch, TurnList, useSelectedTurn, useTurnItems } from './TurnList';
import { useFollowScroll } from './useFollowScroll';

/** How long typing must pause before everything is searched again. */
const SEARCH_WAIT_MS = 150;

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
  // The list's filter: follow shows the newest prompt that passes it; when none does,
  // the one on stage stays (not the newest, which the filter has just ruled out).
  const [query, setQuery] = useState('');
  // Searching everything, the newest prompt with a hit passes. The search waits for typing to
  // pause; a cleared field is the whole list again at once.
  const [{ scope }, setSearchPrefs] = useSearchPrefs();
  const everything = scope === 'everything';
  const settled = useDebounced(query, SEARCH_WAIT_MS);
  const searched = query.trim() === '' ? '' : settled;
  const results = useMemo(
    () => (everything && searchable(searched) ? searchSession(open, agentId, searched) : null),
    [everything, searched, open, agentId],
  );
  const match = useMemo(() => {
    if (!everything) return newestMatch(items, query);
    if (!results) return items.at(-1);
    const newest = results.at(-1)?.turn.id;
    return items.find((it) => it.turn.id === newest);
  }, [everything, results, items, query]);
  const shownId = useRef<string | null>(null);
  const latest = match ?? items.find((it) => it.turn.id === shownId.current) ?? items.at(-1);
  const current = useSelectedTurn(items, open, agentId, route, follow, latest);
  useEffect(() => {
    shownId.current = current?.turn.id ?? null;
  });
  // An empty view says "yet" only while the agent may still add to it.
  const running = mayStillRun(open, agentId);

  // Stable across renders so memoised rows are not invalidated by a new navigate function.
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const enterAgent = useCallback(
    (id: string) => navRef.current({ agentId: id, turnId: null, requestId: null }),
    [],
  );

  // The open card lives in the URL (`card=`), so "that tool call" is a link. Replaced, not
  // pushed: Back goes to the previous view, not through every card opened on the way.
  const turnId = current?.turn.id ?? null;
  const selectCard = useCallback(
    (next: Selection | null) =>
      navRef.current(
        next
          ? { turnId, requestId: next.requestId, card: next.card }
          : { requestId: null, card: undefined },
        { replace: true },
      ),
    [turnId],
  );

  const pickTurn = useCallback(
    (turnId: string) => {
      setFollow(false);
      navigate({ turnId, requestId: null });
    },
    [navigate, setFollow],
  );
  // A hit opens where it is: its prompt, and the card of its call that shows it.
  const openHit = useCallback(
    (hit: SearchHit, turnId: string) => {
      setFollow(false);
      navigate(
        hit.requestId && hit.card
          ? { turnId, requestId: hit.requestId, card: hit.card }
          : { turnId, requestId: null },
      );
    },
    [navigate, setFollow],
  );
  const setScope = useCallback((s: SearchScope) => setSearchPrefs({ scope: s }), [setSearchPrefs]);
  const openCard = useMemo(
    () => (route.requestId && route.card ? { requestId: route.requestId, card: route.card } : null),
    [route.requestId, route.card],
  );
  const backToLatest = () => {
    setFollow(true);
    navigate({ turnId: null, requestId: null });
  };

  return (
    <div className={css.flow}>
      <TurnList
        items={items}
        selectedId={current?.turn.id ?? null}
        onSelect={pickTurn}
        query={query}
        onQuery={setQuery}
        scope={scope}
        onScope={setScope}
        results={results}
        onHit={openHit}
        openCard={openCard}
      />
      <section className={css.main}>
        {current ? (
          <>
            <TurnHeader item={current} actions={<CopyMarkdown open={open} turn={current.turn} />} />
            {!follow && <FollowPausedBar newest={items.at(-1)} onBack={backToLatest} />}
            <CallList
              key={current.turn.id}
              open={open}
              turn={current.turn}
              focusId={follow ? null : (route.requestId ?? null)}
              linked={
                route.requestId && route.card
                  ? { requestId: route.requestId, card: route.card }
                  : null
              }
              onSelectCard={selectCard}
              live={current === items.at(-1) ? live : null}
              follow={follow}
              onUserScrollAway={() => setFollow(false)}
              onEnterAgent={enterAgent}
            />
          </>
        ) : (
          <p className={css.empty}>{t(running ? 'flow.noTurns' : 'flow.noTurnsDone')}</p>
        )}
      </section>
    </div>
  );
}

/** The open card of one call. */
interface Selection {
  requestId: string;
  card: CardKey;
}

interface ListProps {
  open: OpenSession;
  turn: Turn;
  live: LivePartial | null;
  focusId: string | null;
  /** The card the URL names, opened on arrival, Back or Forward. */
  linked: Selection | null;
  onSelectCard(next: Selection | null): void;
  follow: boolean;
  onUserScrollAway(): void;
  onEnterAgent(agentId: string): void;
}

const ROW_GAP = 12;

/** The card open in this call, if any; a tool the call does not have (a stale link) opens none. */
function openCard(
  selected: Selection | null,
  requestId: string,
  tools: ToolCall[],
): CardKey | null {
  if (selected?.requestId !== requestId) return null;
  const { card } = selected;
  return card.startsWith('tool:') && !tools.some((t) => `tool:${t.id}` === card) ? null : card;
}

function CallList({
  open,
  turn,
  live,
  focusId,
  linked,
  onSelectCard,
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
  const [selected, setSelected] = useState<Selection | null>(linked);
  // The URL wins when it changes on its own: a pasted link, Back or Forward.
  const linkedRequest = linked?.requestId ?? null;
  const linkedCard = linked?.card ?? null;
  useEffect(() => {
    setSelected(
      linkedRequest && linkedCard ? { requestId: linkedRequest, card: linkedCard } : null,
    );
  }, [linkedRequest, linkedCard]);
  const awayRef = useRef(onUserScrollAway);
  awayRef.current = onUserScrollAway;
  const selectCardRef = useRef(onSelectCard);
  selectCardRef.current = onSelectCard;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // A call opened by a click is where the reader already is: not scrolled to, not highlighted
  // as a linked one.
  const clickedRef = useRef<string | null>(null);
  const onSelect = useCallback((req: ModelRequest, card: CardKey) => {
    const s = selectedRef.current;
    const next = s?.requestId === req.id && s.card === card ? null : { requestId: req.id, card };
    setSelected(next);
    if (next) {
      clickedRef.current = req.id;
      // An open card must not be scrolled away (and unmounted) by follow mode.
      awayRef.current();
    }
    selectCardRef.current(next);
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
  const linkFocus = focusId !== clickedRef.current ? focusId : null;
  // A linked call lands at the top: its line and cards first, then the panel a card link opens.
  useEffect(() => {
    if (focusIndex >= 0 && linkFocus) virtualizer.scrollToIndex(focusIndex, { align: 'start' });
  }, [focusIndex, linkFocus, virtualizer]);

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
                focused={call.req.id === linkFocus}
                selected={openCard(selected, call.req.id, call.tools)}
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
