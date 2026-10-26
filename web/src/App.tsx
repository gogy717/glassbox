import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { SessionSummary } from '../../src/core/model.js';
import type { RunState } from '../../src/shared/runs.js';
import css from './App.module.css';
import { Delayed } from './components/Delayed';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SessionSidebar } from './components/SessionSidebar';
import { TopBar } from './components/TopBar';
import { ApprovalsContext, useApprovals } from './data/approvals';
import { connectEvents } from './data/events';
import {
  createRunsClient,
  failedSessions,
  pendingPrompts,
  promptsKey,
  type RunsClient,
  runForSession,
  waitingLive,
  withWaiting,
} from './data/runs';
import { SessionAgentContext } from './data/session-agent';
import { createStore, type Store, StoreContext } from './data/store';
import { useNow } from './data/useNow';
import { I18nContext, makeI18n, useI18n } from './i18n';
import { lazyView } from './lib/lazy-view';
import { isListed } from './lib/sessions';
import { applyTheme, loadPrefs, type Prefs, savePrefs } from './prefs';
import { formatRoute, pageOf, parseRoute, sessionLink, useRoute } from './router';
import { UiContext } from './ui';
import { Composer } from './views/composer/Composer';
import { NewSessionDialog } from './views/composer/NewSessionDialog';
import { PermissionDialog } from './views/composer/PermissionDialog';
import { Home } from './views/Home';
import { SessionView } from './views/SessionView';
import type { StatsPageProps } from './views/stats/StatsPage';

// Its own chunk, with the receipt's counting it shares: the first load stays as it was. Fetched
// once the page is idle; from then on it renders without suspending (a lazy view suspends once
// even when loaded, and React holds that fallback a moment), so a first visit shows at once.
let statsModule: typeof import('./views/stats/StatsPage') | null = null;
const loadStats = () =>
  import('./views/stats/StatsPage').then((m) => {
    statsModule = m;
    return m;
  });
const LazyStatsPage = lazyView(() => loadStats().then((m) => m.StatsPage));

function usePrefetchStats(): void {
  useEffect(() => {
    const load = () => void loadStats().catch(() => {});
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(load, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(load, 2000);
    return () => clearTimeout(id);
  }, []);
}

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

/**
 * Where the nav's Session goes (D4): the session page as it was last left (`last`), while that
 * session is still listed, or the list has not arrived to say it is gone; else the most recently
 * active session listed, as Home's link to it picks; null when there is none.
 */
export function sessionTarget(
  last: string | null,
  sessions: SessionSummary[],
  loaded: boolean,
  showProbes: boolean,
): string | null {
  const lastId = last ? parseRoute(last).sessionId : null;
  if (last && lastId && (!loaded || sessions.some((s) => s.id === lastId))) return last;
  const latest = sessions
    .filter((s) => isListed(s, showProbes))
    .reduce<SessionSummary | null>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), null);
  return latest ? sessionLink(latest.id) : null;
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
  const page = pageOf(route);
  usePrefetchStats();
  const here = formatRoute(route);
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
  // Stats lays out as Home does: only a session has a third column to protect.
  const mode = sidebarMode(narrow ? 900 : twoColumns ? 1199 : 1200, page === 'session');
  const mainRef = useRef<HTMLElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // The overlay and the drawer start closed, and close again whenever the page changes under them.
  const [floatOpen, setFloatOpen] = useState(false);
  const pageKey = `${mode}:${page}:${route.sessionId}`;
  const [floatKey, setFloatKey] = useState(pageKey);
  if (floatKey !== pageKey) {
    setFloatKey(pageKey);
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
  // prompt says so, while its process only knows it is busy. A run event arrives with every
  // streamed piece of a reply, so the prompts are read again only when one opens or closes.
  const promptKey = promptsKey(state.runs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: promptKey names every prompt open in state.runs
  const prompts = useMemo(() => pendingPrompts(state.runs), [promptKey]);
  const sessions = useMemo(() => withWaiting(state.sessions, prompts), [state.sessions, prompts]);
  const failures = useMemo(() => failedSessions(state.runs), [state.runs]);
  // The session page as it was last left, agent, tab, turn, request and card: the nav's Session
  // goes back to it, and back on Home that session's row keeps the tab stop.
  const [lastSession, setLastSession] = useState<string | null>(null);
  useEffect(() => {
    if (page === 'session') setLastSession(here);
  }, [page, here]);
  const lastOpened = lastSession ? parseRoute(lastSession).sessionId : null;
  const target = sessionTarget(lastSession, sessions, state.sessionsLoaded, prefs.showProbes);
  const targetId = target ? parseRoute(target).sessionId : null;
  const nav = {
    page,
    here,
    session: target
      ? { href: target, waiting: sessions.some((s) => s.id === targetId && s.live === 'waiting') }
      : null,
    sessionsLoaded: state.sessionsLoaded,
  };
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
            nav={nav}
            menuRef={menuRef}
            sidebarId={SIDEBAR_ID}
            title={route.sessionId ? (summary?.title ?? t('sidebar.untitled')) : null}
            agent={route.sessionId ? (summary?.agent ?? null) : null}
            sidebarOpen={sidebarShown}
            live={summary ? waitingLive(summary, prompts) : null}
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
                failures={failures}
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
              {route.stats ? (
                <ErrorBoundary key="stats">
                  <Suspense
                    fallback={
                      <Delayed>
                        <p className={css.placeholder}>{t('app.loadingView')}</p>
                      </Delayed>
                    }
                  >
                    <StatsContainer
                      window={route.stats}
                      onWindow={(stats) => navigate({ stats }, { replace: true })}
                      showProbes={prefs.showProbes}
                      sessions={state.sessions}
                      quotas={state.quotas}
                    />
                  </Suspense>
                </ErrorBoundary>
              ) : open ? (
                <ErrorBoundary key={open.id}>
                  <ApprovalsContext.Provider value={approvals}>
                    <SessionView
                      open={open}
                      route={route}
                      navigate={navigate}
                      live={run?.partial ?? null}
                      rateAgent={prefs.rateAgent}
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
                  failures={failures}
                  lastOpened={lastOpened}
                  onOpen={(id) => {
                    // From the board, straight onto the prompt, even one hidden with Escape.
                    setDismissed(null);
                    navigate({ sessionId: id, agentId: 'main', turnId: null, requestId: null });
                  }}
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
            {/* Only a session can be written to: Home's header offers a new one, Stats talks to
                no one. */}
            {page === 'session' && (
              <Composer
                session={summary}
                run={run}
                client={runs}
                onNewSession={() => setNewSession(true)}
                onRunStarted={onRunStarted}
              />
            )}
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

function StatsContainer(props: Omit<StatsPageProps, 'now'>) {
  // Reset times and the head's span move by the minute at most.
  const now = useNow(30_000);
  const Page = statsModule?.StatsPage ?? LazyStatsPage;
  return <Page {...props} now={now} />;
}

function SidebarContainer(props: Omit<Parameters<typeof SessionSidebar>[0], 'now'>) {
  // Relative times only need to move every half minute.
  const now = useNow(30_000);
  return <SessionSidebar {...props} now={now} />;
}
