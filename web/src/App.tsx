import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RunState } from '../../src/shared/runs.js';
import css from './App.module.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SessionSidebar } from './components/SessionSidebar';
import { TopBar } from './components/TopBar';
import { ApprovalsContext, useApprovals } from './data/approvals';
import { connectEvents } from './data/events';
import { createRunsClient, type RunsClient, runForSession } from './data/runs';
import { SessionAgentContext } from './data/session-agent';
import { createStore, type Store, StoreContext } from './data/store';
import { useNow } from './data/useNow';
import { I18nContext, makeI18n, useI18n } from './i18n';
import { applyTheme, loadPrefs, type Prefs, savePrefs } from './prefs';
import { useRoute } from './router';
import { UiContext } from './ui';
import { Composer } from './views/composer/Composer';
import { NewSessionDialog } from './views/composer/NewSessionDialog';
import { PermissionDialog } from './views/composer/PermissionDialog';
import { Home } from './views/Home';
import { SessionView } from './views/SessionView';

export interface AppProps {
  /** Injected in tests; the real app creates its own. */
  store?: Store;
  connect?: (store: Store, sessionId: string | null) => () => void;
  runs?: RunsClient;
}

const NARROW = '(max-width: 900px)';

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (fn: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', fn);
      return () => mql.removeEventListener('change', fn);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false,
  );
}

export function App({ store: given, connect = connectEvents, runs: givenRuns }: AppProps) {
  const [store] = useState(() => given ?? createStore());
  const [runs] = useState(() => givenRuns ?? createRunsClient());
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const i18n = useMemo(() => makeI18n(prefs.locale), [prefs.locale]);
  useEffect(() => {
    applyTheme(prefs.theme);
    savePrefs(prefs);
    document.documentElement.lang = i18n.locale === 'zh' ? 'zh-CN' : 'en';
  }, [prefs, i18n.locale]);

  return (
    <StoreContext.Provider value={store}>
      <I18nContext.Provider value={i18n}>
        <Shell store={store} connect={connect} runs={runs} prefs={prefs} onPrefs={setPrefs} />
      </I18nContext.Provider>
    </StoreContext.Provider>
  );
}

interface ShellProps {
  store: Store;
  connect: NonNullable<AppProps['connect']>;
  runs: RunsClient;
  prefs: Prefs;
  onPrefs(p: Prefs): void;
}

function Shell({ store, connect, runs, prefs, onPrefs }: ShellProps) {
  const { t } = useI18n();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [route, navigate] = useRoute();
  const [follow, setFollow] = useState(true);
  // Pausing follow is about the session being read: opening another one starts it afresh.
  const [followSession, setFollowSession] = useState(route.sessionId);
  if (followSession !== route.sessionId) {
    setFollowSession(route.sessionId);
    setFollow(true);
  }
  const narrow = useMediaQuery(NARROW);
  const mainRef = useRef<HTMLElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const ui = useMemo(() => ({ follow, setFollow }), [follow]);

  useEffect(() => {
    store.openSession(route.sessionId);
    return connect(store, route.sessionId);
  }, [store, connect, route.sessionId]);

  // B-lite: the run attached to this session, and a new/forked run whose session we are waiting
  // to learn so we can open it.
  const run = runForSession(state.runs, route.sessionId);
  const approvals = useApprovals(state.runs, route.sessionId);
  const [newSession, setNewSession] = useState(false);
  const [awaiting, setAwaiting] = useState<string | null>(null);
  useEffect(() => {
    const target = awaiting ? state.runs.get(awaiting) : undefined;
    if (!target?.sessionId) return;
    setAwaiting(null);
    navigate({ sessionId: target.sessionId, agentId: 'main', turnId: null, requestId: null });
  }, [awaiting, state.runs, navigate]);
  const onRunStarted = (r: RunState) => {
    setNewSession(false);
    if (r.sessionId === route.sessionId && r.sessionId !== null) return; // resumed in place
    // New and forked runs learn their session id once Claude Code starts; open it then.
    if (r.sessionId)
      navigate({ sessionId: r.sessionId, agentId: 'main', turnId: null, requestId: null });
    else setAwaiting(r.id);
  };
  const pending = run?.pendingPermissions[0];
  // Escape collapses a prompt without answering it; a newer prompt shows itself again.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const showPrompt = !!pending && pending.id !== dismissed;
  const knownToRun = [...state.runs.values()].some((r) => r.sessionId === route.sessionId);

  const open = state.open;
  const summary = open?.session ?? state.sessions.find((s) => s.id === route.sessionId) ?? null;
  const sidebarShown = narrow ? drawerOpen : !sidebarCollapsed;

  return (
    <UiContext.Provider value={ui}>
      <SessionAgentContext.Provider value={summary?.agent ?? 'claude-code'}>
        <div className={css.app}>
          {/* The first Tab stop: past the top bar and the session list, straight to the content.
              A button, not a link to #main: the hash holds the route. */}
          <button type="button" className={css.skip} onClick={() => mainRef.current?.focus()}>
            {t('app.skipToContent')}
          </button>
          <TopBar
            title={route.sessionId ? (summary?.title ?? t('sidebar.untitled')) : null}
            live={summary?.live ?? null}
            connection={state.connection}
            quotas={state.quotas}
            follow={follow}
            onFollow={setFollow}
            prefs={prefs}
            onPrefs={onPrefs}
            onToggleSidebar={() =>
              narrow ? setDrawerOpen(!drawerOpen) : setSidebarCollapsed(!sidebarCollapsed)
            }
          />
          <div className={css.body} data-sidebar={sidebarShown ? 'shown' : 'hidden'}>
            {narrow && drawerOpen && (
              <div className={css.scrim} aria-hidden="true" onClick={() => setDrawerOpen(false)} />
            )}
            <aside className={css.sidebar} hidden={!sidebarShown}>
              <SidebarContainer
                sessions={state.sessions}
                selectedId={route.sessionId}
                showProbes={prefs.showProbes}
                onSelect={(id) => {
                  setDrawerOpen(false);
                  navigate({ sessionId: id, agentId: 'main', turnId: null, requestId: null });
                }}
              />
            </aside>
            <main ref={mainRef} tabIndex={-1} className={css.main}>
              {open ? (
                <ErrorBoundary key={open.id}>
                  <ApprovalsContext.Provider value={approvals}>
                    <SessionView
                      open={open}
                      route={route}
                      navigate={navigate}
                      live={run?.partial ?? null}
                    />
                  </ApprovalsContext.Provider>
                </ErrorBoundary>
              ) : route.sessionId ? (
                <p className={css.placeholder}>
                  {/* The list has loaded and does not know this id: it will never arrive. */}
                  {state.missingId === route.sessionId ||
                  (state.sessions.length > 0 &&
                    !knownToRun &&
                    !state.sessions.some((s) => s.id === route.sessionId))
                    ? t('app.notFound')
                    : t('app.loading')}
                </p>
              ) : (
                <HomeContainer
                  sessions={state.sessions}
                  loaded={state.sessionsLoaded}
                  showProbes={prefs.showProbes}
                  onOpen={(id) =>
                    navigate({ sessionId: id, agentId: 'main', turnId: null, requestId: null })
                  }
                  onNewSession={() => setNewSession(true)}
                />
              )}
            </main>
          </div>
          <div className={css.footer} id="composer-slot">
            {run && pending && showPrompt && (
              <PermissionDialog
                key={pending.id}
                request={pending}
                onDecide={(d) => runs.decide(run.id, pending.id, d)}
                onDismiss={() => setDismissed(pending.id)}
              />
            )}
            {pending && !showPrompt && (
              <button type="button" className={css.reopen} onClick={() => setDismissed(null)}>
                {t('perm.reopen')}
              </button>
            )}
            <Composer
              session={summary}
              run={run}
              client={runs}
              onNewSession={() => setNewSession(true)}
              onRunStarted={onRunStarted}
            />
          </div>
          {newSession && (
            <NewSessionDialog
              client={runs}
              onStarted={onRunStarted}
              onClose={() => setNewSession(false)}
            />
          )}
        </div>
      </SessionAgentContext.Provider>
    </UiContext.Provider>
  );
}

function HomeContainer(props: Omit<Parameters<typeof Home>[0], 'now'>) {
  const now = useNow(30_000);
  return <Home {...props} now={now} />;
}

function SidebarContainer(props: Omit<Parameters<typeof SessionSidebar>[0], 'now'>) {
  // Relative times only need to move every half minute.
  const now = useNow(30_000);
  return <SessionSidebar {...props} now={now} />;
}
