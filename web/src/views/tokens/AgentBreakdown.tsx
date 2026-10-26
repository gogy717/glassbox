import { Workflow } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { RunStatus } from '../../../../src/core/model.js';
import { totalTokens } from '../../../../src/core/usage.js';
import { FigureText } from '../../components/FigureText';
import { StatusMark, type UiStatus } from '../../components/Status';
import { Switch } from '../../components/Switch';
import { TokenBar } from '../../components/TokenBar';
import { useI18n } from '../../i18n';
import { formatNumber } from '../../lib/format';
import { type Cost, costText, costTitle } from '../../lib/prices';
import type { RollupRow } from '../../lib/token-stats';
import css from './TokensView.module.css';

type Sort = 'tree' | 'spend';

/**
 * Every tape is at least this wide, so a sub-agent's cache / write / output mix reads even under
 * a Main many times its size. All rows keep one scale; the figure beside each carries the size.
 */
const TAPE_MIN = 24;

interface Props {
  rows: RollupRow[];
  /** What each row would cost on the API, by `${kind}:${id}` (`rollupCosts`). */
  costs: ReadonlyMap<string, Cost>;
  selectedId: string;
  onSelect(agentId: string): void;
}

/** A sub-agent's run status as a mark: one never seen to end is the quiet hollow dot. */
const markOf = (s: RunStatus): UiStatus => (s === 'unknown' ? 'waiting' : s);

export function AgentBreakdown({ rows, costs, selectedId, onSelect }: Props) {
  const { t, intl } = useI18n();
  // The cost column: the row's calls as dollars, "no price" when none of them has one.
  const costCell = (r: RollupRow) => {
    const cost = costs.get(`${r.kind}:${r.id}`);
    const text = cost ? costText(cost, t, intl) : null;
    return {
      text,
      cell: (
        <span
          className={`${css.rowCost} figure`}
          data-cost
          title={cost && text ? costTitle(cost, t) : undefined}
        >
          {text}
        </span>
      ),
    };
  };
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
    <section className={css.section} aria-labelledby="tok-by-agent">
      <div className={css.sectionHead}>
        <h3 id="tok-by-agent">{t('tokens.byAgent')}</h3>
        <Switch<Sort>
          label={t('tokens.order')}
          value={sort}
          size="small"
          options={[
            { value: 'tree', label: t('tokens.sortTree') },
            { value: 'spend', label: t('tokens.sortSpend') },
          ]}
          onChange={setSort}
        />
      </div>
      <div className={css.rows}>
        {shown.map((r) => {
          const usage = barUsage(r);
          const n = formatNumber(totalTokens(usage), intl);
          // Indent inside the label column so every tape starts at the same x and compares.
          const indent = { paddingLeft: r.depth * 16 };
          const cost = costCell(r);
          if (r.kind !== 'agent')
            return (
              <div key={`${r.kind}:${r.id}`} className={css.groupRow} data-group={r.kind}>
                <span className={css.rowLabel} style={indent}>
                  {r.kind === 'workflow' && <Workflow size={12} aria-hidden="true" />}
                  <span className={r.kind === 'phase' ? 'section-label' : undefined}>
                    {r.label}
                  </span>
                  {r.kind === 'workflow' && (
                    <span className={css.groupKind}>{t('tokens.workflow')}</span>
                  )}
                </span>
                <TokenBar usage={usage} scale={scale} height={6} minWidth={TAPE_MIN} />
                <span className={`${css.rowValue} figure`}>{n}</span>
                {cost.cell}
              </div>
            );
          const hasKids = totalTokens(r.total) !== totalTokens(r.own);
          const label = r.agent.id === 'main' ? t('crumb.main') : r.label;
          const status = markOf(r.agent.status);
          // Never seen to end: "Ended (unknown)", as on the tool cards, not "Waiting".
          const word =
            r.agent.status === 'unknown' ? t('status.unknownEnd') : t(`status.${status}`);
          return (
            <button
              key={r.id}
              type="button"
              className={css.agentRow}
              aria-current={r.id === selectedId ? 'true' : undefined}
              // The row's name replaces its contents, so it names the agent's state and cost too.
              aria-label={`${t('tokens.rowLabel', { label, status: word, n })}${cost.text ? ` · ${cost.text}` : ''}`}
              onClick={() => onSelect(r.id)}
            >
              <span className={css.rowLabel} style={indent}>
                <StatusMark status={status} label={word} compact />
                <span data-label>{label}</span>
              </span>
              <TokenBar usage={usage} scale={scale} height={6} minWidth={TAPE_MIN} />
              <span className={css.rowValue}>
                <span className="figure">{n}</span>
                {hasKids && sort === 'tree' && (
                  <small>
                    <FigureText
                      k="tokens.inclSub"
                      params={{ n: formatNumber(totalTokens(r.total), intl) }}
                    />
                  </small>
                )}
              </span>
              {cost.cell}
            </button>
          );
        })}
      </div>
    </section>
  );
}

const barUsage = (r: RollupRow) => (r.kind === 'agent' ? r.own : r.total);
