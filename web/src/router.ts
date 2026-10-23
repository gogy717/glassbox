import { useCallback, useSyncExternalStore } from 'react';
import { MAIN_AGENT_ID } from '../../src/core/model.js';

export const TABS = ['flow', 'steps', 'tokens', 'time'] as const;
export type Tab = (typeof TABS)[number];

/** Everything the URL remembers, so a view can be bookmarked or reloaded. */
export interface Route {
  sessionId: string | null;
  agentId: string;
  tab: Tab;
  turnId: string | null;
  /** A request to scroll to and highlight (set by click-through from other tabs). */
  requestId: string | null;
}

const HOME: Route = {
  sessionId: null,
  agentId: MAIN_AGENT_ID,
  tab: 'flow',
  turnId: null,
  requestId: null,
};

export function parseRoute(hash: string): Route {
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
  return {
    sessionId,
    agentId: q.get('agent') || MAIN_AGENT_ID,
    tab: TABS.includes(tab as Tab) ? (tab as Tab) : 'flow',
    turnId: q.get('turn') || null,
    requestId: q.get('req') || null,
  };
}

export function formatRoute(r: Route): string {
  if (r.sessionId === null) return '#/';
  const q = new URLSearchParams();
  if (r.agentId !== MAIN_AGENT_ID) q.set('agent', r.agentId);
  if (r.tab !== 'flow') q.set('tab', r.tab);
  if (r.turnId) q.set('turn', r.turnId);
  if (r.requestId) q.set('req', r.requestId);
  const qs = q.toString();
  return `#/s/${encodeURIComponent(r.sessionId)}${qs ? `?${qs}` : ''}`;
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
    const target = formatRoute({ ...parseRoute(window.location.hash), ...next });
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
