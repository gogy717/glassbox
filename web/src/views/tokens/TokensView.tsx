import { Lightbulb } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import type { ModelRequest } from '../../../../src/core/model.js';
import { MAIN_AGENT_ID } from '../../../../src/core/model.js';
import { totalTokens } from '../../../../src/core/usage.js';
import { TokenBar, TokenLegend } from '../../components/TokenBar';
import type { OpenSession } from '../../data/store';
import { useI18n } from '../../i18n';
import { subtreeIds } from '../../lib/agents';
import { formatNumber, formatPercent } from '../../lib/format';
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

const TOP_N = 10;

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

  const openInFlow = useCallback(
    (req: ModelRequest) => {
      setFollow(false);
      navigate({ tab: 'flow', agentId: req.agentId, turnId: req.turnId, requestId: req.id });
    },
    [navigate, setFollow],
  );

  if (!total || totalTokens(total) === 0) return <p className={css.empty}>{t('tokens.noData')}</p>;

  return (
    <div className={css.view}>
      {found.length > 0 && (
        <div className={css.insight} role="note">
          <Lightbulb size={16} aria-hidden="true" />
          <div>
            {found.map((i) => (
              <p key={i.key}>
                {i.key === 'tokens.insightCacheRead'
                  ? t(i.key, { pct: formatPercent(i.share, intl) })
                  : t(i.key, {
                      agent: i.agentId === MAIN_AGENT_ID ? t('crumb.main') : i.label,
                      pct: formatPercent(i.share, intl),
                    })}
              </p>
            ))}
          </div>
        </div>
      )}

      <section className={css.card} aria-labelledby="tok-total">
        <div className={css.cardHead}>
          <h3 id="tok-total">{t('tokens.total')}</h3>
          <span className={`${css.big} num`}>{formatNumber(totalTokens(total), intl)}</span>
        </div>
        <TokenBar usage={total} height={14} />
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
            title={t('tokens.contextOf', { agent: agentName })}
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
