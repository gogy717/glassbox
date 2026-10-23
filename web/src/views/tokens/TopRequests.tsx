import type { ModelRequest, TokenUsage } from '../../../../src/core/model.js';
import { MAIN_AGENT_ID } from '../../../../src/core/model.js';
import { totalTokens } from '../../../../src/core/usage.js';
import { TokenBar } from '../../components/TokenBar';
import type { OpenSession } from '../../data/store';
import { useI18n } from '../../i18n';
import { formatNumber } from '../../lib/format';
import css from './TokensView.module.css';

interface Props {
  open: OpenSession;
  requests: ModelRequest[];
  onPick(req: ModelRequest): void;
}

export function TopRequests({ open, requests, onPick }: Props) {
  const { t, intl } = useI18n();
  const scale = requests[0]?.usage ? totalTokens(requests[0].usage) : 1;
  return (
    <section className={css.card} aria-labelledby="tok-top">
      <div className={css.cardHead}>
        <h3 id="tok-top">{t('tokens.top', { n: requests.length })}</h3>
      </div>
      <ol className={css.top}>
        {requests.map((r) => {
          const usage = r.usage as TokenUsage;
          const agent = open.agents.get(r.agentId);
          const turn = r.turnId ? open.turns.get(r.turnId) : undefined;
          return (
            <li key={r.id}>
              <button type="button" className={css.topRow} onClick={() => onPick(r)}>
                <span className={css.topWho}>
                  <span className={css.topAgent}>
                    {r.agentId === MAIN_AGENT_ID ? t('crumb.main') : (agent?.label ?? r.agentId)}
                  </span>
                  <span className={css.topRef}>
                    {t('tokens.requestRef', { turn: turn?.index ?? '—', n: r.index })}
                  </span>
                </span>
                <TokenBar usage={usage} scale={scale} />
                <span className={`${css.rowValue} num`}>
                  {formatNumber(totalTokens(usage), intl)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
