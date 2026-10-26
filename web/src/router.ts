import { useCallback, useSyncExternalStore } from 'react';
import { MAIN_AGENT_ID } from '../../src/core/model.js';
import { type WeekWindowKind, weekStart } from '../../src/shared/week.js';

export const TABS = ['flow', 'steps', 'tokens', 'time', 'files'] as const;
export type Tab = (typeof TABS)[number];

/** The pages of the top bar's nav. */
export type Page = 'home' | 'session' | 'stats' | 'inbox';

/** Which card of a call is open: its request, its response, or one of its tools (`tool:<id>`). */
export type CardKey = 'request' | 'response' | `tool:${string}`;

const isCardKey = (v: string | null): v is CardKey =>
  v === 'request' || v === 'response' || (!!v && /^tool:./.test(v));

/** Everything the URL remembers, so a view can be bookmarked or reloaded. */
export interface Route {
  sessionId: string | null;
  agentId: string;
  tab: Tab;
  turnId: string | null;
  /** A request to scroll to and highlight (set by click-through from other tabs). */
  requestId: string | null;
  /** The card of `requestId` whose panel is open, so a link opens that tool call; absent when
   *  the panel is closed. Only ever set with `requestId`. */
  card?: CardKey;
  /** The Stats page, over this window; absent on the other pages. */
  stats?: WeekWindowKind;
  /**
   * The Inbox page, opening at the item of this session (a notification's), or null; absent on
   * the other pages.
   */
  inbox?: { item: string | null };
}

const HOME: Route = {
  sessionId: null,
  agentId: MAIN_AGENT_ID,
  tab: 'flow',
  turnId: null,
  requestId: null,
};

/** The page a route shows: the Inbox, Stats, else the session it names, else Home. */
export const pageOf = (r: Route): Page =>
  r.inbox ? 'inbox' : r.stats ? 'stats' : r.sessionId ? 'session' : 'home';

export function parseRoute(hash: string): Route {
  const inbox = /^#\/inbox(?:\?(.*))?$/.exec(hash);
  if (inbox)
    return { ...HOME, inbox: { item: new URLSearchParams(inbox[1] ?? '').get('item') || null } };
  const stats = /^#\/stats(?:\?(.*))?$/.exec(hash);
  if (stats) {
    const kind = new URLSearchParams(stats[1] ?? '').get('window');
    return { ...HOME, stats: kind === '7d' ? '7d' : 'week' };
  }
  const m = /^#\/s\/([^?]+)(?:\?(.*))?$/.exec(hash);
  if (!m) return HOME;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(m[1] as string);
  } catch {
    // A hand-edited or truncated link: show the home screen instead of crashing on every load.
    return HOME;
  }
  const q = new URLSearchParams(m[2] ?? '');
  const tab = q.get('tab');
  const requestId = q.get('req') || null;
  const card = q.get('card');
  return {
    sessionId,
    agentId: q.get('agent') || MAIN_AGENT_ID,
    tab: TABS.includes(tab as Tab) ? (tab as Tab) : 'flow',
    turnId: q.get('turn') || null,
    requestId,
    ...(requestId && isCardKey(card) ? { card } : {}),
  };
}

export function formatRoute(r: Route): string {
  if (r.inbox) return r.inbox.item ? `#/inbox?item=${encodeURIComponent(r.inbox.item)}` : '#/inbox';
  // This week is the page's own default, as the flow tab is a session's.
  if (r.stats) return r.stats === 'week' ? '#/stats' : `#/stats?window=${r.stats}`;
  if (r.sessionId === null) return '#/';
  const q = new URLSearchParams();
  if (r.agentId !== MAIN_AGENT_ID) q.set('agent', r.agentId);
  if (r.tab !== 'flow') q.set('tab', r.tab);
  if (r.turnId) q.set('turn', r.turnId);
  if (r.requestId) q.set('req', r.requestId);
  // A card belongs to its request: clearing the request (a new turn, agent or session) closes it.
  if (r.requestId && r.card) q.set('card', r.card);
  const qs = q.toString();
  return `#/s/${encodeURIComponent(r.sessionId)}${qs ? `?${qs}` : ''}`;
}

/** A link to a session as it opens: its main agent, on the flow tab, following its latest turn. */
export const sessionLink = (sessionId: string) => formatRoute({ ...HOME, sessionId });

/** A link to the Inbox, opening at the item of `sessionId` when one is named. */
export const inboxLink = (sessionId: string | null = null) =>
  formatRoute({ ...HOME, inbox: { item: sessionId } });

const DAY_MS = 86_400_000;

/** Whether the week is less than a day old: a Monday's "This week" holds little yet (D, F7). */
export const youngWeek = (now: number): boolean => now - weekStart(now) < DAY_MS;

/**
 * Where the nav's Stats link goes: this week, or the last 7 days while the week is less than a
 * day old. `#/stats` itself keeps meaning this week; only the link chooses.
 */
export const statsLink = (now: number): string =>
  formatRoute({ ...HOME, stats: youngWeek(now) ? '7d' : 'week' });

/** What the open card belongs to: moving any of these elsewhere leaves it behind. */
const CARD_OWNERS = ['sessionId', 'agentId', 'turnId', 'requestId'] as const;

/**
 * `next` over `current`. A card is one request's, so a move to another request, turn, agent or
 * session that does not name a card closes it, rather than opening the same card of a request
 * nobody asked about (a Response panel left open, then a step clicked in the steps view). A
 * session named without `stats` or `inbox` is opened: a click on one leaves the Stats page or the
 * Inbox for it. One page at a time: Stats named leaves the Inbox, and the Inbox Stats.
 */
export function mergeRoute(current: Route, next: Partial<Route>): Route {
  const merged = { ...current, ...next };
  const moved = CARD_OWNERS.some((k) => k in next && next[k] !== current[k]);
  if (moved && !('card' in next)) delete merged.card;
  if ('sessionId' in next && !('stats' in next)) delete merged.stats;
  if ('sessionId' in next && !('inbox' in next)) delete merged.inbox;
  if ('stats' in next && !('inbox' in next)) delete merged.inbox;
  if ('inbox' in next && !('stats' in next)) delete merged.stats;
  return merged;
}

const subscribe = (fn: () => void) => {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
};
const getHash = () => window.location.hash;

export type Navigate = (next: Partial<Route>, opts?: { replace?: boolean }) => void;

/** The current route and a navigate function that merges into it. */
export function useRoute(): [Route, Navigate] {
  const hash = useSyncExternalStore(subscribe, getHash);
  const route = parseRoute(hash);
  const navigate = useCallback<Navigate>((next, opts) => {
    const target = formatRoute(mergeRoute(parseRoute(window.location.hash), next));
    if (target === window.location.hash || (target === '#/' && !window.location.hash)) return;
    if (opts?.replace) {
      history.replaceState(null, '', target);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else {
      window.location.hash = target;
    }
  }, []);
  return [route, navigate];
}
