import { Workflow } from 'lucide-react';
import { useMemo, useState } from 'react';
import { totalTokens } from '../../../../src/core/usage.js';
import { LiveDot } from '../../components/Status';
import { TokenBar } from '../../components/TokenBar';
import { useI18n } from '../../i18n';
import { formatNumber } from '../../lib/format';
import type { RollupRow } from '../../lib/token-stats';
import css from './TokensView.module.css';

type Sort = 'tree' | 'spend';

interface Props {
  rows: RollupRow[];
  selectedId: string;
  onSelect(agentId: string): void;
}

export function AgentBreakdown({ rows, selectedId, onSelect }: Props) {
  const { t, intl } = useI18n();
  const [sort, setSort] = useState<Sort>('tree');
  // Agent bars show the agent's own spend so nothing is counted twice; groups show their sum.
  const shown = useMemo(() => {
    if (sort === 'tree') return rows;
    return rows
      .filter((r) => r.kind === 'agent')
      .map((r) => ({ ...r, depth: 0 }))
      .sort((a, b) => totalTokens(barUsage(b)) - totalTokens(barUsage(a)));
  }, [rows, sort]);
  const scale = Math.max(1, ...shown.map((r) => totalTokens(barUsage(r))));

  return (
    <section className={css.card} aria-labelledby="tok-by-agent">
      <div className={css.cardHead}>
        <h3 id="tok-by-agent">{t('tokens.byAgent')}</h3>
        <div className={css.segmented} role="radiogroup" aria-label={t('tokens.byAgent')}>
          {(['tree', 'spend'] as const).map((s) => (
            // biome-ignore lint/a11y/useSemanticElements: a two-option segmented control, styled as buttons
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={sort === s}
              onClick={() => setSort(s)}
            >
              {t(s === 'tree' ? 'tokens.sortTree' : 'tokens.sortSpend')}
            </button>
          ))}
        </div>
      </div>
      <div className={css.rows}>
        {shown.map((r) => {
          const usage = barUsage(r);
          const n = formatNumber(totalTokens(usage), intl);
          // Indent inside the label column so every bar starts at the same x.
          const indent = { paddingLeft: r.depth * 16 };
          if (r.kind !== 'agent')
            return (
              <div key={`${r.kind}:${r.id}`} className={css.groupRow}>
                <span className={css.rowLabel} style={indent}>
                  {r.kind === 'workflow' && <Workflow size={12} aria-hidden="true" />}
                  <span data-group={r.kind}>{r.label}</span>
                </span>
                <TokenBar usage={usage} scale={scale} height={8} />
                <span className={`${css.rowValue} num`}>{n}</span>
              </div>
            );
          const hasKids = totalTokens(r.total) !== totalTokens(r.own);
          const label = r.agent.id === 'main' ? t('crumb.main') : r.label;
          return (
            <button
              key={r.id}
              type="button"
              className={css.agentRow}
              aria-current={r.id === selectedId ? 'true' : undefined}
              // The row's name replaces its contents, so it names the agent's state too.
              aria-label={t('tokens.rowLabel', { label, status: t(`status.${r.agent.status}`), n })}
              onClick={() => onSelect(r.id)}
            >
              <span className={css.rowLabel} style={indent}>
                <LiveDot state={r.agent.status} label={t(`status.${r.agent.status}`)} />
                <span data-label>{label}</span>
              </span>
              <TokenBar usage={usage} scale={scale} />
              <span className={`${css.rowValue} num`}>
                {n}
                {hasKids && sort === 'tree' && (
                  <small>
                    {t('tokens.inclSub', { n: formatNumber(totalTokens(r.total), intl) })}
                  </small>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

const barUsage = (r: RollupRow) => (r.kind === 'agent' ? r.own : r.total);
