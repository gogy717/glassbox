import { Eye, Menu, SlidersHorizontal } from 'lucide-react';
import { type Ref, useEffect, useRef, useState } from 'react';
import type { AgentKind, LiveState, QuotaSnapshot } from '../../../src/core/model.js';
import type { ConnectionState } from '../data/store';
import { useNow } from '../data/useNow';
import { useI18n } from '../i18n';
import type { Prefs } from '../prefs';
import { AgentTag } from './AgentTag';
import { QuotaBar } from './QuotaBar';
import { LiveDot } from './Status';
import css from './TopBar.module.css';

interface Props {
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
}

export function TopBar(p: Props) {
  const { t } = useI18n();
  return (
    <header className={css.bar}>
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
      <span className={css.logo}>
        <Wordmark />
        glassbox
      </span>
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
      <TopQuota quotas={p.quotas} />
      <span role="status" className={css.conn} data-state={p.connection}>
        {t(`conn.${p.connection}`)}
      </span>
      {/* Named by its word, which narrow screens hide: the eye alone still says Follow latest. */}
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

function TopQuota({ quotas }: { quotas: QuotaSnapshot[] }) {
  // Reset countdowns are shown to the minute; no need to re-render every second.
  const now = useNow(30_000);
  return <QuotaBar quotas={quotas} now={now} />;
}

function SettingsMenu({ prefs, onPrefs }: { prefs: Prefs; onPrefs(p: Prefs): void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={css.settings} ref={ref}>
      <button
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
        </div>
      )}
    </div>
  );
}
