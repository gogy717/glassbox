import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { RunState } from '../../src/shared/runs.js';
import css from './App.module.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SessionSidebar } from './components/SessionSidebar';
import { TopBar } from './components/TopBar';
import { ApprovalsContext, useApprovals } from './data/approvals';
import { connectEvents } from './data/events';
import {
  createRunsClient,
  type RunsClient,
  runForSession,
  waitingSessionIds,
  withWaiting,
} from './data/runs';
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
const TWO_COLUMNS = '(max-width: 1199px)';
/** The session list's element, for the menu button that shows and hides it. */
const SIDEBAR_ID = 'session-list';

export type SidebarMode = 'column' | 'overlay' | 'drawer';

/**
 * Three columns only at 1200px and up. Below that a session keeps two (the conversation list and
 * the stage), so the session list floats over them as an overlay, closed until asked for; Home
 * has no third column to protect and keeps it. At 900px and below it is the drawer.
 */
export function sidebarMode(width: number, hasSession: boolean): SidebarMode {
  if (width <= 900) return 'drawer';
  return width < 1200 && hasSession ? 'overlay' : 'column';
}

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
  // Pausing follow is about the session being read: opening another one starts it afresh,
  // following its latest turn, unless the link names a turn or a request (a pasted link, Back or
  // Forward), which then stays on screen.
  const followsLatest = !route.turnId && !route.requestId;
  const [follow, setFollow] = useState(followsLatest);
  const [followSession, setFollowSession] = useState(route.sessionId);
  if (followSession !== route.sessionId) {
    setFollowSession(route.sessionId);
    setFollow(followsLatest);
  }
  const narrow = useMediaQuery(NARROW);
  const twoColumns = useMediaQuery(TWO_COLUMNS);
  const mode = sidebarMode(narrow ? 900 : twoColumns ? 1199 : 1200, route.sessionId !== null);
  const mainRef = useRef<HTMLElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // The overlay and the drawer start closed, and close again whenever the page changes under them.
  const [floatOpen, setFloatOpen] = useState(false);
  const [floatKey, setFloatKey] = useState(`${mode}:${route.sessionId}`);
  if (floatKey !== `${mode}:${route.sessionId}`) {
    setFloatKey(`${mode}:${route.sessionId}`);
    setFloatOpen(false);
  }
  const floating = mode !== 'column';
  // Open over the page, the list is a modal dialog: the page behind it is inert.
  const modal = floating && floatOpen;
  const closeFloat = useCallback(() => {
    setFloatOpen(false);
    menuRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!modal) return;
    // Opened from the menu button: start in the search field, not behind the scrim.
    asideRef.current?.querySelector<HTMLElement>('input')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeFloat();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal, closeFloat]);
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
  // A session with a prompt open is waiting for you, in the top bar and the list: the composer's
  // prompt says so, while its process only knows it is busy.
  const waitingKey = waitingSessionIds(state.runs).join('\n');
  const sessions = useMemo(
    () => withWaiting(state.sessions, waitingKey ? waitingKey.split('\n') : []),
    [state.sessions, waitingKey],
  );
  // Escape collapses a prompt without answering it; a newer prompt shows itself again.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const showPrompt = !!pending && pending.id !== dismissed;
  const knownToRun = [...state.runs.values()].some((r) => r.sessionId === route.sessionId);

  const open = state.open;
  const summary = open?.session ?? state.sessions.find((s) => s.id === route.sessionId) ?? null;
  const sidebarShown = floating ? floatOpen : !sidebarCollapsed;
  // A session picked from the overlay: carry on in it once <main> is no longer inert (a browser
  // refuses focus inside an inert subtree, so not in the click handler).
  const focusMainOnClose = useRef(false);
  useLayoutEffect(() => {
    if (modal || !focusMainOnClose.current) return;
    focusMainOnClose.current = false;
    mainRef.current?.focus();
  }, [modal]);
  // The list went away with focus inside (a resize past a breakpoint): keep focus on the page.
  useLayoutEffect(() => {
    if (!sidebarShown && asideRef.current?.contains(document.activeElement))
      menuRef.current?.focus();
  }, [sidebarShown]);

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
            menuRef={menuRef}
            sidebarId={SIDEBAR_ID}
            title={route.sessionId ? (summary?.title ?? t('sidebar.untitled')) : null}
            agent={route.sessionId ? (summary?.agent ?? null) : null}
            sidebarOpen={sidebarShown}
            live={pending ? 'waiting' : (summary?.live ?? null)}
            connection={state.connection}
            quotas={state.quotas}
            follow={follow}
            onFollow={setFollow}
            prefs={prefs}
            onPrefs={onPrefs}
            onToggleSidebar={() =>
              floating ? setFloatOpen(!floatOpen) : setSidebarCollapsed(!sidebarCollapsed)
            }
          />
          <div
            className={css.body}
            data-sidebar={sidebarShown ? 'shown' : 'hidden'}
            data-sidebar-mode={mode}
          >
            {modal && <div className={css.scrim} aria-hidden="true" onClick={closeFloat} />}
            <aside
              ref={asideRef}
              id={SIDEBAR_ID}
              className={css.sidebar}
              hidden={!sidebarShown}
              {...(modal
                ? { role: 'dialog', 'aria-modal': true, 'aria-label': t('sidebar.title') }
                : {})}
            >
              <SidebarContainer
                sessions={sessions}
                loaded={state.sessionsLoaded}
                selectedId={route.sessionId}
                showProbes={prefs.showProbes}
                onSelect={(id) => {
                  navigate({ sessionId: id, agentId: 'main', turnId: null, requestId: null });
                  if (!floating) return;
                  // The list goes away: carry on in the session just opened.
                  focusMainOnClose.current = true;
                  setFloatOpen(false);
                }}
              />
            </aside>
            <main ref={mainRef} tabIndex={-1} className={css.main} inert={modal}>
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
                  sessions={sessions}
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
          <div className={css.footer} id="composer-slot" inert={modal}>
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
