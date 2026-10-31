import { Fragment, type ReactNode, useMemo } from 'react';
import { MAIN_AGENT_ID } from '../../../../src/core/model.js';
import { CompactFigure } from '../../components/CompactFigure';
import { FigureText } from '../../components/FigureText';
import { usePriceTable } from '../../data/price-table';
import { useSessionAgent } from '../../data/session-agent';
import type { OpenSession } from '../../data/store';
import { type MessageKey, type Params, translateParts, useI18n } from '../../i18n';
import { subtreeIds } from '../../lib/agents';
import {
  type CacheBreak,
  cacheBreakCost,
  cacheBreaks,
  reasonSentence,
  reasonWord,
} from '../../lib/cache-breaks';
import { formatClock, formatCompact } from '../../lib/format';
import { costText, costTitle } from '../../lib/prices';
import type { Navigate } from '../../router';
import { useUi } from '../../ui';
import css from './CacheBreaks.module.css';

interface Props {
  open: OpenSession;
  agentId: string;
  navigate: Navigate;
}

/** A text whose compact counts ("412K", "41.2万") keep a CJK unit out of the mono face. */
function Compact({ k, params, compact }: { k: MessageKey; params: Params; compact: string[] }) {
  const { locale } = useI18n();
  return (
    <>
      {translateParts(locale, k, params).map((p, i) =>
        typeof p === 'string' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <Fragment key={i}>{p}</Fragment>
        ) : compact.includes(p.param) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <CompactFigure key={i} value={p.value} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <span key={i} className="figure">
            {p.value}
          </span>
        ),
      )}
    </>
  );
}

/**
 * "Cache breaks", in Where tokens went: the requests of the chosen agent and its sub-agents whose
 * cached prefix no longer matched (`lib/cache-breaks.ts`), how many tokens they wrote again and
 * what that would cost on the API, one row per break linking to its request. Nothing when the
 * cache never broke; "not available" when the agent records no cache figures per request.
 */
export function CacheBreaks({ open, agentId, navigate }: Props) {
  const { t, intl } = useI18n();
  const agent = useSessionAgent();
  const { setFollow } = useUi();
  const prices = usePriceTable();
  const found = useMemo(
    () => cacheBreaks(open, new Set(subtreeIds(open, agentId))),
    [open, agentId],
  );
  const cost = useMemo(
    () => (found.available ? cacheBreakCost(found.breaks, prices) : null),
    [found, prices],
  );
  if (found.available && found.breaks.length === 0) return null;

  const agentName =
    agentId === MAIN_AGENT_ID ? t('crumb.main') : (open.agents.get(agentId)?.label ?? agentId);
  const go = (b: CacheBreak) => {
    setFollow(false);
    navigate({
      tab: 'flow',
      agentId: b.request.agentId,
      turnId: b.request.turnId,
      requestId: b.request.id,
      card: 'request',
    });
  };
  const approx = (n: number) => `≈${formatCompact(n, intl)}`;

  let body: ReactNode;
  if (!found.available) {
    body = <p className={css.message}>{t('cacheBreaks.notAvailable', { agent })}</p>;
  } else {
    const rewritten = found.breaks.reduce((n, b) => n + b.rewritten, 0);
    const costShown = cost && costText(cost, t, intl);
    body = (
      <>
        <p className={css.summary}>
          <Compact
            k="cacheBreaks.summary"
            params={{ n: found.breaks.length, k: formatCompact(rewritten, intl) }}
            compact={['k']}
          />
          {costShown && cost && (
            <span className={css.cost} title={costTitle(cost, t)}>
              {' · '}
              {cost.priced ? (
                <FigureText k="cacheBreaks.cost" params={{ cost: costShown }} />
              ) : (
                costShown
              )}
            </span>
          )}
        </p>
        <ol className={css.list}>
          {found.breaks.map((b) => {
            const req = b.request;
            const turn = req.turnId ? open.turns.get(req.turnId) : undefined;
            const other = req.agentId !== agentId;
            const rowCost = costText(cacheBreakCost([b], prices), t, intl);
            return (
              <li key={req.id}>
                <button
                  type="button"
                  className={css.row}
                  title={reasonSentence(b, t)}
                  aria-label={t('cacheBreaks.row', {
                    time: formatClock(req.startedAt),
                    reason: reasonWord(b, t),
                    k: formatCompact(b.rewritten, intl),
                  })}
                  onClick={() => go(b)}
                >
                  <span className={css.who}>
                    <span className={css.reason} data-reason={b.reason}>
                      {reasonWord(b, t)}
                    </span>
                    <span className={css.ref}>
                      <span className="figure">{formatClock(req.startedAt)}</span>
                      {' · '}
                      <FigureText
                        k="tokens.requestRef"
                        params={{ turn: turn?.index ?? '—', n: req.index }}
                      />
                      {other && ` · ${open.agents.get(req.agentId)?.label ?? req.agentId}`}
                    </span>
                  </span>
                  <span className={css.value}>
                    <CompactFigure value={approx(b.rewritten)} />
                  </span>
                  <span className={`${css.rowCost} figure`}>{rowCost}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className={css.note}>{t('cacheBreaks.note')}</p>
      </>
    );
  }

  return (
    <section className={css.section} aria-labelledby="tok-breaks">
      <div className={css.head}>
        <h3 id="tok-breaks">
          {t('cacheBreaks.title')} <span className={css.agent}>· {agentName}</span>
        </h3>
      </div>
      {body}
    </section>
  );
}
