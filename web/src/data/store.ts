import { createContext, useContext, useState, useSyncExternalStore } from 'react';
import type {
  AgentNode,
  Diagnostics,
  ModelRequest,
  QuotaSnapshot,
  SessionSnapshot,
  SessionSummary,
  ToolCall,
  Turn,
  WorkflowRun,
} from '../../../src/core/model.js';
import type { ServerEvent } from '../../../src/shared/protocol.js';
import type { TokenRate } from '../../../src/shared/rate.js';
import type { RunState } from '../../../src/shared/runs.js';
import { createWeekCache, type WeekCache } from './weeks';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting';

/** The open session's entities, normalised by id so patches are plain upserts. */
export interface OpenSession {
  id: string;
  session: SessionSummary;
  agents: Map<string, AgentNode>;
  turns: Map<string, Turn>;
  requests: Map<string, ModelRequest>;
  toolCalls: Map<string, ToolCall>;
  workflows: Map<string, WorkflowRun>;
  diagnostics: Diagnostics;
}

export interface ViewState {
  sessions: SessionSummary[];
  /** False until the first session list arrives, so "no sessions" is never claimed too early. */
  sessionsLoaded: boolean;
  connection: ConnectionState;
  /** The session the user asked for; `open` stays null until its snapshot arrives. */
  openId: string | null;
  /** Set when the server reports `openId` as missing after waiting for it (session-missing). */
  missingId: string | null;
  open: OpenSession | null;
  /** Plan quota per provider (account-wide, not per session). */
  quotas: QuotaSnapshot[];
  /** Runs glassbox started (B-lite), by id; replayed by the server on every connect. */
  runs: Map<string, RunState>;
}

export interface Store {
  getState(): ViewState;
  subscribe(fn: () => void): () => void;
  applyEvent(e: ServerEvent): void;
  /**
   * The machine's token rate, kept apart from the view state: it moves every few seconds, and
   * only the instruments that show it should re-render, not the whole page.
   */
  getRate(): TokenRate | null;
  subscribeRate(fn: () => void): () => void;
  /** The week, per window, for the Stats page and the weekly receipt alike (R30). */
  weeks: WeekCache;
  openSession(id: string | null): void;
  setConnection(c: ConnectionState): void;
}

const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((i) => [i.id, i]));

/** Copy-on-write upsert: unchanged maps keep their identity so memoised views skip work. */
function upsert<T extends { id: string }>(map: Map<string, T>, items: T[]): Map<string, T> {
  if (items.length === 0) return map;
  const next = new Map(map);
  for (const item of items) next.set(item.id, item);
  return next;
}

/** Copy-on-write delete; the map keeps its identity when none of the ids are present. */
function remove<T>(map: Map<string, T>, ids: string[] | undefined): Map<string, T> {
  if (!ids?.some((id) => map.has(id))) return map;
  const next = new Map(map);
  for (const id of ids) next.delete(id);
  return next;
}

export function fromSnapshot(id: string, s: SessionSnapshot): OpenSession {
  return {
    id,
    session: s.session,
    agents: byId(s.agents),
    turns: byId(s.turns),
    requests: byId(s.requests),
    toolCalls: byId(s.toolCalls),
    workflows: byId(s.workflows),
    diagnostics: s.diagnostics,
  };
}

export function createStore(): Store {
  let state: ViewState = {
    sessions: [],
    sessionsLoaded: false,
    connection: 'connecting',
    openId: null,
    missingId: null,
    open: null,
    quotas: [],
    runs: new Map(),
  };
  const listeners = new Set<() => void>();
  let rate: TokenRate | null = null;
  const rateListeners = new Set<() => void>();
  const set = (next: ViewState) => {
    state = next;
    for (const fn of listeners) fn();
  };

  const applyEvent = (e: ServerEvent) => {
    switch (e.type) {
      case 'sessions':
        set({ ...state, sessions: e.sessions, sessionsLoaded: true });
        return;
      case 'snapshot':
        if (e.sessionId !== state.openId) return;
        set({ ...state, open: fromSnapshot(e.sessionId, e.snapshot), missingId: null });
        return;
      case 'patch': {
        const open = state.open;
        // Before the snapshot there is nothing to patch; the snapshot will include these.
        if (!open || e.sessionId !== open.id) return;
        const p = e.patch;
        // Removals apply after the upserts (an id never appears in both within one patch).
        const gone = p.removed ?? {};
        set({
          ...state,
          sessions: state.sessions.map((s) => (s.id === p.session.id ? p.session : s)),
          open: {
            ...open,
            session: p.session,
            agents: remove(upsert(open.agents, p.agents), gone.agents),
            turns: remove(upsert(open.turns, p.turns), gone.turns),
            requests: remove(upsert(open.requests, p.requests), gone.requests),
            toolCalls: remove(upsert(open.toolCalls, p.toolCalls), gone.toolCalls),
            workflows: remove(upsert(open.workflows, p.workflows), gone.workflows),
            diagnostics: p.diagnostics ?? open.diagnostics,
          },
        });
        return;
      }
      case 'quota':
        set({ ...state, quotas: e.quotas });
        return;
      case 'rate':
        rate = e.rate;
        for (const fn of rateListeners) fn();
        return;
      case 'run':
        set({ ...state, runs: new Map(state.runs).set(e.run.id, e.run) });
        return;
      case 'session-missing':
        if (e.sessionId === state.openId) set({ ...state, missingId: e.sessionId });
        return;
      case 'heartbeat':
        return;
    }
  };

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    applyEvent,
    getRate: () => rate,
    subscribeRate(fn) {
      rateListeners.add(fn);
      return () => rateListeners.delete(fn);
    },
    weeks: createWeekCache(),
    openSession(id) {
      if (id === state.openId) return;
      set({ ...state, openId: id, open: null, missingId: null });
    },
    setConnection(connection) {
      if (connection !== state.connection) set({ ...state, connection });
    },
  };
}

export const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore outside StoreContext');
  return store;
}

const noSubscription = () => () => {};

/** The token rate, re-rendering only the caller when it moves; null outside a store too. */
export function useRate(): TokenRate | null {
  const store = useContext(StoreContext);
  return useSyncExternalStore(store ? store.subscribeRate : noSubscription, () =>
    store ? store.getRate() : null,
  );
}

/** The page's week cache: the store's, or outside a store (a lone dialog's test) one of its own. */
export function useWeekCache(): WeekCache {
  const store = useContext(StoreContext);
  const [own] = useState(() => (store ? null : createWeekCache()));
  return store?.weeks ?? (own as WeekCache);
}

/** Every window's entry in the week cache, re-rendering the caller when one changes. */
export const useWeeksOf = (weeks: WeekCache) => useSyncExternalStore(weeks.subscribe, weeks.get);

/**
 * Subscribes to a slice of the view state. The selector must return an existing value
 * (not a freshly built object or array), or React will re-render forever.
 */
export function useViewState<T>(selector: (s: ViewState) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
