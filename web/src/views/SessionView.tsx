import { type KeyboardEvent, Suspense } from 'react';
import { MAIN_AGENT_ID } from '../../../src/core/model.js';
import type { LivePartial } from '../../../src/shared/runs.js';
import { AgentBreadcrumb } from '../components/AgentBreadcrumb';
import { SummaryBar } from '../components/SummaryBar';
import type { OpenSession } from '../data/store';
import { useI18n } from '../i18n';
import { lazyView } from '../lib/lazy-view';
import { type Navigate, type Route, TABS } from '../router';
import { FlowView } from './flow/FlowView';
import css from './SessionView.module.css';
import { StepsView } from './steps/StepsView';

// The charts' views load on first use: the app's first chunk stays under Vite's 500 kB line.
const TimeView = lazyView(() => import('./time/TimeView').then((m) => m.TimeView));
const TokensView = lazyView(() => import('./tokens/TokensView').then((m) => m.TokensView));

interface Props {
  open: OpenSession;
  route: Route;
  navigate: Navigate;
  /** Streaming reply of a glassbox-owned run on this session. */
  live?: LivePartial | null;
  /** The CLI the top bar shows the token rate for: the readout's narrow figure. */
  rateAgent?: string | null;
}

export function SessionView({ open, route, navigate, live = null, rateAgent = null }: Props) {
  const { t } = useI18n();
  // An agent from a stale link (or one whose patch has not arrived yet) falls back to main.
  const agentId = open.agents.has(route.agentId) ? route.agentId : MAIN_AGENT_ID;

  // WAI-ARIA tabs: arrows move (and wrap), Home/End jump; the focused tab is selected at once.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    // Relative to the focused tab: the route lags behind fast key presses (hashchange is async).
    const i = TABS.indexOf(e.currentTarget.dataset.tab as (typeof TABS)[number]);
    const next =
      e.key === 'ArrowRight'
        ? TABS[(i + 1) % TABS.length]
        : e.key === 'ArrowLeft'
          ? TABS[(i - 1 + TABS.length) % TABS.length]
          : e.key === 'Home'
            ? TABS[0]
            : e.key === 'End'
              ? TABS[TABS.length - 1]
              : undefined;
    if (!next) return;
    e.preventDefault();
    document.getElementById(`tab-${next}`)?.focus();
    navigate({ tab: next });
  };

  return (
    <div className={css.view}>
      <SummaryBar open={open} agentId={agentId} rateAgent={rateAgent} />
      <div className={css.toolbar}>
        <AgentBreadcrumb
          open={open}
          agentId={agentId}
          onSelect={(id) => navigate({ agentId: id, turnId: null, requestId: null })}
        />
        <div className={css.tabs} role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`tab-${tab}`}
              aria-selected={route.tab === tab}
              aria-controls="tabpanel"
              tabIndex={route.tab === tab ? 0 : -1}
              data-tab={tab}
              className={css.tab}
              onClick={() => navigate({ tab })}
              onKeyDown={onTabKey}
            >
              {t(`tab.${tab}`)}
            </button>
          ))}
        </div>
      </div>
      <div className={css.panel} role="tabpanel" id="tabpanel" aria-labelledby={`tab-${route.tab}`}>
        {route.tab === 'flow' && (
          <FlowView open={open} agentId={agentId} route={route} navigate={navigate} live={live} />
        )}
        {route.tab === 'steps' && (
          <StepsView open={open} agentId={agentId} route={route} navigate={navigate} />
        )}
        <Suspense fallback={<p className={css.loading}>{t('app.loadingView')}</p>}>
          {route.tab === 'time' && <TimeView open={open} agentId={agentId} navigate={navigate} />}
          {route.tab === 'tokens' && (
            <TokensView open={open} agentId={agentId} navigate={navigate} />
          )}
        </Suspense>
      </div>
    </div>
  );
}
