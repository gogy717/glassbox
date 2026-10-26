import {
  ChartNoAxesColumn,
  Eye,
  House,
  Menu,
  Search,
  SlidersHorizontal,
  SquareTerminal,
} from 'lucide-react';
import { type Ref, useCallback, useId, useRef, useState } from 'react';
import type { AgentKind, LiveState, QuotaSnapshot } from '../../../src/core/model.js';
import { askToNotify, notifyState } from '../data/notifications';
import { keyLabel, paletteKeys } from '../data/shortcuts';
import type { ConnectionState } from '../data/store';
import { useNow } from '../data/useNow';
import { useI18n } from '../i18n';
import type { Prefs } from '../prefs';
import { type Page, statsLink } from '../router';
import { AgentTag } from './AgentTag';
import { useOnePopover, usePopoverDismiss } from './popover';
import { QuotaBar } from './QuotaBar';
import { LiveDot } from './Status';
import switchCss from './Switch.module.css';
import { TokenRate } from './TokenRate';
import css from './TopBar.module.css';

/** Where the page nav's items go (D4); the current page's item stays where it is. */
export interface PageNavProps {
  page: Page;
  /** The current route, as a link. */
  here: string;
  /** Session's target, and whether that session waits for you; null when there is none. */
  session: { href: string; waiting: boolean } | null;
  /** The session list has arrived: until it has, no session is not yet "no sessions". */
  sessionsLoaded: boolean;
}

interface Props {
  nav: PageNavProps;
  /** The menu button, for focus to return to when the floating session list closes. */
  menuRef?: Ref<HTMLButtonElement>;
  title: string | null;
  /** The coding agent of the open session. */
  agent: AgentKind | null;
  /** The session list's id, for the menu button's aria-controls. */
  sidebarId: string;
  /** Whether the session list is open, for the menu button's pressed state. */
  sidebarOpen: boolean;
  live: LiveState | null;
  connection: ConnectionState;
  quotas: QuotaSnapshot[];
  follow: boolean;
  onFollow(on: boolean): void;
  prefs: Prefs;
  onPrefs(p: Prefs): void;
  onToggleSidebar(): void;
  /** Opens the palette (⌘K): Jump to… beside Settings. */
  onJump?(): void;
}

export function TopBar(p: Props) {
  const { t } = useI18n();
  return (
    <header className={css.bar} data-session={p.title !== null || undefined}>
      <button
        ref={p.menuRef}
        type="button"
        className={css.iconButton}
        aria-label={t('sidebar.toggle')}
        aria-expanded={p.sidebarOpen}
        aria-controls={p.sidebarId}
        onClick={p.onToggleSidebar}
      >
        <Menu size={16} aria-hidden="true" />
      </button>
      <a href="#/" className={css.logo}>
        <Wordmark />
        <span className={css.wordmark}>glassbox</span>
      </a>
      <PageNav {...p.nav} />
      {p.title !== null && (
        <span className={css.session}>
          {p.agent && <AgentTag kind={p.agent} />}
          <span className={css.title} title={p.title}>
            {p.title}
          </span>
          {p.live && (
            <span className={css.live} data-state={p.live}>
              <LiveDot state={p.live} />
              {t(`live.${p.live}`)}
            </span>
          )}
        </span>
      )}
      <span className={css.spacer} />
      <TokenRate
        agent={p.prefs.rateAgent}
        onAgent={(rateAgent) => p.onPrefs({ ...p.prefs, rateAgent })}
        sessionOpen={p.title !== null}
      />
      <TopQuota quotas={p.quotas} sessionOpen={p.title !== null} />
      {/* News only while it is not connected (a chip); connected, read but not seen, so the
          status region announces the next drop and the recovery alike. */}
      <span role="status" className={css.conn} data-state={p.connection}>
        {t(`conn.${p.connection}`)}
      </span>
      {/* A session-page control: Home and Stats have no latest turn to follow. Named by its
          word, which narrow screens hide: the eye alone still says Follow latest. */}
      {p.nav.page === 'session' && (
        <button
          type="button"
          className={css.toggle}
          aria-pressed={p.follow}
          aria-label={t('follow.label')}
          title={t('follow.label')}
          onClick={() => p.onFollow(!p.follow)}
        >
          <Eye size={14} aria-hidden="true" />
          <span className={css.toggleLabel} aria-hidden="true">
            {t('follow.label')}
          </span>
        </button>
      )}
      {/* The palette, where the eye looks for settings. Named by its word at every width (the
          word goes when narrow), its keys beside it and said to assistive tech. */}
      {p.onJump && (
        <button
          type="button"
          className={css.jump}
          aria-label={t('palette.title')}
          aria-keyshortcuts={paletteKeys()}
          title={`${t('palette.title')} ${keyLabel('Mod+k')}`}
          onClick={p.onJump}
        >
          <Search size={14} aria-hidden="true" />
          <span className={css.jumpLabel}>{t('palette.title')}</span>
          <kbd className={css.jumpKeys}>{keyLabel('Mod+k')}</kbd>
        </button>
      )}
      <SettingsMenu prefs={p.prefs} onPrefs={p.onPrefs} />
    </header>
  );
}

/** The box you can see into: a rounded square with a dot. */
function Wordmark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className={css.mark}>
      <rect
        x="2.5"
        y="2.5"
        width="13"
        height="13"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="9" cy="9" r="2.25" fill="currentColor" />
    </svg>
  );
}

function TopQuota({ quotas, sessionOpen }: { quotas: QuotaSnapshot[]; sessionOpen: boolean }) {
  // Reset countdowns are shown to the minute; no need to re-render every second.
  const now = useNow(30_000);
  return <QuotaBar quotas={quotas} now={now} sessionOpen={sessionOpen} />;
}

/**
 * Home · Session · Stats (D4): the Switch's segmented family, one level above a session's
 * underlined view tabs. Links, so Back, Forward and a new tab work as anywhere; the current
 * page's item links to where you are. Session opens the session page as it was last left, else
 * the most recently active session, with the amber dot while that session waits for you; with
 * no session to open it is unavailable, still reachable, its title saying why.
 */
function PageNav({ page, here, session, sessionsLoaded }: PageNavProps) {
  const { t } = useI18n();
  const waitingId = useId();
  const item = (p: Page) => ({
    className: `${switchCss.word} ${css.page}`,
    'aria-current': p === page ? ('page' as const) : undefined,
  });
  const label = (text: string) => <span className={css.pageLabel}>{text}</span>;
  const sessionHref = page === 'session' ? here : (session?.href ?? null);
  // Off the session page only: on it, the session's own state says so beside its title.
  const waiting = page !== 'session' && !!session?.waiting;
  return (
    <nav
      aria-label={t('nav.label')}
      className={`${switchCss.switch} ${css.pages}`}
      data-variant="segmented"
    >
      <a href="#/" title={t('nav.home')} {...item('home')}>
        <House size={14} aria-hidden="true" />
        {label(t('nav.home'))}
      </a>
      {sessionHref ? (
        <a
          href={sessionHref}
          title={t('nav.session')}
          aria-describedby={waiting ? waitingId : undefined}
          {...item('session')}
        >
          <SquareTerminal size={14} aria-hidden="true" />
          {label(t('nav.session'))}
          {waiting && <span className={css.waiting} data-waiting aria-hidden="true" />}
        </a>
      ) : (
        // Unavailable, not missing: focusable, so its title (why) is read out as well as hovered.
        <a
          role="link"
          aria-disabled="true"
          tabIndex={0}
          title={t(sessionsLoaded ? 'nav.noSessions' : 'home.connecting')}
          {...item('session')}
        >
          <SquareTerminal size={14} aria-hidden="true" />
          {label(t('nav.session'))}
        </a>
      )}
      <a
        href={page === 'stats' ? here : statsLink(Date.now())}
        title={t('nav.stats')}
        {...item('stats')}
      >
        <ChartNoAxesColumn size={14} aria-hidden="true" />
        {label(t('nav.stats'))}
      </a>
      {waiting && (
        <span id={waitingId} hidden>
          {t('live.waiting')}
        </span>
      )}
    </nav>
  );
}

function SettingsMenu({ prefs, onPrefs }: { prefs: Prefs; onPrefs(p: Prefs): void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useOnePopover('settings', open, close);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  usePopoverDismiss(ref, open, close, buttonRef);

  return (
    <div className={css.settings} ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className={css.iconButton}
        aria-label={t('settings.title')}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className={css.popover} role="dialog" aria-label={t('settings.title')}>
          <label>
            <span>{t('settings.language')}</span>
            <select
              value={prefs.locale}
              onChange={(e) => onPrefs({ ...prefs, locale: e.target.value as Prefs['locale'] })}
            >
              <option value="en">English</option>
              <option value="zh">中文</option>
            </select>
          </label>
          <label>
            <span>{t('settings.theme')}</span>
            <select
              value={prefs.theme}
              onChange={(e) => onPrefs({ ...prefs, theme: e.target.value as Prefs['theme'] })}
            >
              <option value="system">{t('settings.themeSystem')}</option>
              <option value="light">{t('settings.themeLight')}</option>
              <option value="dark">{t('settings.themeDark')}</option>
            </select>
          </label>
          <label className={css.check}>
            <input
              type="checkbox"
              checked={prefs.showProbes}
              onChange={(e) => onPrefs({ ...prefs, showProbes: e.target.checked })}
            />
            <span>{t('settings.showProbes')}</span>
          </label>
          <NotifySetting prefs={prefs} onPrefs={onPrefs} />
        </div>
      )}
    </div>
  );
}

/**
 * "Notify me when a session needs me" (F1), off by default. Turning it on asks the browser's
 * permission once; refused, the box stays off and says so, as it does when the browser offers no
 * notifications. On only while the browser allows it: a permission withdrawn since turns it off.
 */
function NotifySetting({ prefs, onPrefs }: { prefs: Prefs; onPrefs(p: Prefs): void }) {
  const { t } = useI18n();
  const noteId = useId();
  // The browser's answer, read again after asking.
  const [state, setState] = useState(notifyState);
  const toggle = async (on: boolean) => {
    if (!on) return onPrefs({ ...prefs, notify: false });
    const answer = await askToNotify();
    setState(answer);
    if (answer === 'granted') onPrefs({ ...prefs, notify: true });
  };
  const note =
    state === 'unsupported'
      ? t('settings.notifyUnsupported')
      : state === 'denied'
        ? t('settings.notifyBlocked')
        : null;
  return (
    <>
      <label className={css.check}>
        <input
          type="checkbox"
          checked={prefs.notify && state === 'granted'}
          disabled={state === 'unsupported'}
          aria-describedby={note ? noteId : undefined}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>{t('settings.notify')}</span>
      </label>
      {note && (
        <p id={noteId} className={css.note}>
          {note}
        </p>
      )}
    </>
  );
}
