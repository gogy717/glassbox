import type { ModelRequest, TokenUsage } from '../../../../src/core/model.js';
import { MAIN_AGENT_ID } from '../../../../src/core/model.js';
import { totalTokens } from '../../../../src/core/usage.js';
import { FigureText } from '../../components/FigureText';
import { usePriceTable } from '../../data/price-table';
import type { OpenSession } from '../../data/store';
import { useI18n } from '../../i18n';
import { formatNumber } from '../../lib/format';
import { costText, costTitle, sumCost } from '../../lib/prices';
import css from './TokensView.module.css';

interface Props {
  open: OpenSession;
  requests: ModelRequest[];
  onPick(req: ModelRequest): void;
}

/**
 * The costliest requests: who, where (as numbered in the execution chain), how many tokens, and
 * what they would cost on the API.
 */
export function TopRequests({ open, requests, onPick }: Props) {
  const { t, intl } = useI18n();
  const prices = usePriceTable();
  return (
    <section className={css.section} aria-labelledby="tok-top">
      <div className={css.sectionHead}>
        <h3 id="tok-top">{t('tokens.top', { n: requests.length })}</h3>
      </div>
      <ol className={css.top}>
        {requests.map((r) => {
          const usage = r.usage as TokenUsage;
          const agent = open.agents.get(r.agentId);
          const turn = r.turnId ? open.turns.get(r.turnId) : undefined;
          const cost = sumCost([r], prices);
          const costShown = costText(cost, t, intl);
          return (
            <li key={r.id}>
              <button type="button" className={css.topRow} onClick={() => onPick(r)}>
                <span className={css.topWho}>
                  <span className={css.topAgent}>
                    {r.agentId === MAIN_AGENT_ID ? t('crumb.main') : (agent?.label ?? r.agentId)}
                  </span>
                  <span className={css.topRef}>
                    <FigureText
                      k="tokens.requestRef"
                      params={{ turn: turn?.index ?? '—', n: r.index }}
                    />
                  </span>
                </span>
                <span className={`${css.topValue} figure`}>
                  {formatNumber(totalTokens(usage), intl)}
                </span>
                <span
                  className={`${css.topCost} figure`}
                  title={costShown ? costTitle(cost, t) : undefined}
                >
                  {costShown}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
