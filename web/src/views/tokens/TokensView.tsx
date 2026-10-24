import { useCallback, useMemo } from 'react';
import type { ModelRequest } from '../../../../src/core/model.js';
import { MAIN_AGENT_ID } from '../../../../src/core/model.js';
import { totalTokens } from '../../../../src/core/usage.js';
import { FigureText } from '../../components/FigureText';
import { TokenBar, TokenLegend } from '../../components/TokenBar';
import { useSessionAgentKind } from '../../data/session-agent';
import { type OpenSession, useViewState } from '../../data/store';
import { useNow } from '../../data/useNow';
import { useI18n } from '../../i18n';
import { mayStillRun, subtreeIds } from '../../lib/agents';
import { formatNumber, formatPercent, formatRelative } from '../../lib/format';
import { providerShortName } from '../../lib/provider-names';
import { quotaWindowName, sessionQuota } from '../../lib/quota';
import { contextSeries, insights, rollupByAgent, topRequests } from '../../lib/token-stats';
import type { Navigate } from '../../router';
import { useUi } from '../../ui';
import { AgentBreakdown } from './AgentBreakdown';
import { ContextChart } from './ContextChart';
import css from './TokensView.module.css';
import { TopRequests } from './TopRequests';

interface Props {
  open: OpenSession;
  agentId: string;
  navigate: Navigate;
}

const TOP_N = 5;

export function TokensView({ open, agentId, navigate }: Props) {
  const { t, intl } = useI18n();
  const { setFollow } = useUi();

  const rows = useMemo(() => rollupByAgent(open), [open]);
  const found = useMemo(() => insights(open), [open]);
  const series = useMemo(() => contextSeries(open, agentId), [open, agentId]);
  const top = useMemo(() => topRequests(open, TOP_N, subtreeIds(open, agentId)), [open, agentId]);
  const selected = rows.find((r) => r.kind === 'agent' && r.id === agentId);
  const total = selected?.total;
  const agentName =
    agentId === MAIN_AGENT_ID ? t('crumb.main') : (open.agents.get(agentId)?.label ?? agentId);
  // The plan this session's agent draws on, placed beside its tokens, never subtracted from them.
  const kind = useSessionAgentKind();
  const quotas = useViewState((s) => s.quotas);
  // Picked when the quotas change, not on a clock: QuotaLine ticks its own age.
  const quota = useMemo(() => sessionQuota(kind, quotas, Date.now()), [kind, quotas]);

  const openInFlow = useCallback(
    (req: ModelRequest) => {
      setFollow(false);
      // Lands on the request's card, open, as a link to it does.
      navigate({
        tab: 'flow',
        agentId: req.agentId,
        turnId: req.turnId,
        requestId: req.id,
        card: 'request',
      });
    },
    [navigate, setFollow],
  );

  // "Yet" only while the agent may still add to it.
  if (!total || totalTokens(total) === 0)
    return (
      <p className={css.empty}>
        {t(mayStillRun(open, agentId) ? 'tokens.noData' : 'tokens.noDataDone')}
      </p>
    );

  return (
    <div className={css.view}>
      {(found.length > 0 || quota) && (
        // The takeaway is a lede, not an alert: amber stays for what needs the person.
        <div className={css.lede} role="note">
          {/* One sentence leads; a second takeaway sits under it, quiet like the plan line. */}
          {found.map((i, n) => (
            <p key={i.key} className={n === 0 ? css.ledeText : css.ledeMore}>
              {i.key === 'tokens.insightCacheRead' ? (
                <FigureText k={i.key} params={{ pct: formatPercent(i.share, intl) }} />
              ) : (
                <FigureText
                  k={i.key}
                  params={{
                    agent: i.agentId === MAIN_AGENT_ID ? t('crumb.main') : i.label,
                    pct: formatPercent(i.share, intl),
                  }}
                  figures={['pct']}
                />
              )}
            </p>
          ))}
          {quota && <QuotaLine {...quota} />}
        </div>
      )}

      <section className={css.section} aria-labelledby="tok-total">
        <div className={css.sectionHead}>
          <h3 id="tok-total">{t('tokens.total')}</h3>
          <span className={`${css.total} figure`}>{formatNumber(totalTokens(total), intl)}</span>
        </div>
        <TokenBar usage={total} height={8} />
        <TokenLegend usage={total} />
      </section>

      <div className={css.columns}>
        <AgentBreakdown
          rows={rows}
          selectedId={agentId}
          onSelect={(id) => navigate({ agentId: id })}
        />
        <div className={css.stack}>
          <ContextChart
            agent={agentName}
            points={series}
            onPick={(id) => {
              const req = open.requests.get(id);
              if (req) openInFlow(req);
            }}
          />
          <TopRequests open={open} requests={top} onPick={openInFlow} />
        </div>
      </div>
    </div>
  );
}

/**
 * The plan window next to this session's tokens, in one muted sentence: a session's tokens and a
 * plan window are different units (cache reads, a share of a window), so they are never added up.
 */
function QuotaLine({ snapshot, window }: NonNullable<ReturnType<typeof sessionQuota>>) {
  const { t, intl } = useI18n();
  const now = useNow(60_000);
  const params = {
    provider: providerShortName(snapshot.provider),
    window: quotaWindowName(window, t),
    pct: `${Math.round(Math.min(100, Math.max(0, window.usedPercent)))}%`,
  };
  return (
    <p className={css.quota}>
      {snapshot.stale ? (
        <FigureText
          k="tokens.quotaStale"
          params={{ ...params, age: formatRelative(snapshot.fetchedAt, now, intl) }}
          figures={['pct']}
        />
      ) : (
        <FigureText k="tokens.quota" params={params} figures={['pct']} />
      )}
    </p>
  );
}
