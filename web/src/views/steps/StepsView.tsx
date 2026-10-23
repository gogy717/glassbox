import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useApprovalsContext } from '../../data/approvals';
import type { OpenSession } from '../../data/store';
import { useNow } from '../../data/useNow';
import { useI18n } from '../../i18n';
import { mayStillRun } from '../../lib/agents';
import { formatDuration, formatNumber } from '../../lib/format';
import { buildSteps, type Phase, type PhaseCategory, type Step } from '../../lib/steps';
import type { Navigate, Route } from '../../router';
import { useUi } from '../../ui';
import { TurnList, useSelectedTurn, useTurnItems } from '../flow/TurnList';
import { TurnTitle } from '../flow/TurnTitle';
import { useFollowScroll } from '../flow/useFollowScroll';
import { CategoryIcon } from './CategoryIcon';
import { StepItem } from './StepItem';
import css from './StepsView.module.css';

interface Props {
  open: OpenSession;
  agentId: string;
  route: Route;
  navigate: Navigate;
}

type Row = { kind: 'phase'; phase: Phase; key: string } | { kind: 'step'; step: Step; key: string };

export function StepsView({ open, agentId, route, navigate }: Props) {
  const { t } = useI18n();
  const { follow, setFollow } = useUi();
  const items = useTurnItems(open, agentId);
  const current = useSelectedTurn(items, open, agentId, route, follow);
  // An empty view says "yet" only while the agent may still add to it.
  const running = mayStillRun(open, agentId);
  // Durations of a running step grow with the clock; finished turns need no ticking.
  const live = current?.status === 'running' || current?.status === 'approval';
  const now = useNow(live ? 1000 : 60_000);
  const approvals = useApprovalsContext();
  const phases = useMemo(
    () => (current ? buildSteps(open, agentId, current.turn.id, now, approvals) : []),
    [open, agentId, current, now, approvals],
  );

  const pickTurn = useCallback(
    (turnId: string) => {
      setFollow(false);
      navigate({ turnId, requestId: null });
    },
    [navigate, setFollow],
  );
  const openStep = useCallback(
    (requestId: string) => {
      setFollow(false);
      navigate({ tab: 'flow', agentId, turnId: current?.turn.id ?? null, requestId });
    },
    [navigate, setFollow, agentId, current],
  );

  return (
    <div className={css.layout}>
      <TurnList items={items} selectedId={current?.turn.id ?? null} onSelect={pickTurn} />
      <section className={css.main}>
        {current ? (
          <>
            <div className={css.turnHead}>
              <TurnTitle key={current.turn.id} text={current.heading} />
              <PhaseShares phases={phases} />
            </div>
            <StepList
              key={current.turn.id}
              phases={phases}
              running={live}
              follow={follow}
              onUserScrollAway={() => setFollow(false)}
              onOpen={openStep}
            />
          </>
        ) : (
          <p className={css.empty}>{t(running ? 'flow.noTurns' : 'flow.noTurnsDone')}</p>
        )}
        {!follow && (
          <button
            type="button"
            className={css.back}
            onClick={() => {
              setFollow(true);
              navigate({ turnId: null, requestId: null });
            }}
          >
            <ArrowDown size={14} aria-hidden="true" />
            {t('follow.back')}
          </button>
        )}
      </section>
    </div>
  );
}

/** Where the turn's time went, phase by phase, with a labelled legend per category. */
function PhaseShares({ phases }: { phases: Phase[] }) {
  const { t } = useI18n();
  const total = phases.reduce((s, p) => s + (p.durationMs ?? 0), 0);
  if (total <= 0) return null;
  const byCat = new Map<PhaseCategory, number>();
  for (const p of phases) byCat.set(p.category, (byCat.get(p.category) ?? 0) + (p.durationMs ?? 0));
  return (
    <div className={css.shares}>
      <div className={css.shareBar} aria-hidden="true">
        {phases.map((p) =>
          p.durationMs ? (
            <span
              key={`${p.category}-${p.steps[0]?.requestId}`}
              data-cat={p.category}
              style={{
                flexGrow: p.durationMs,
                background:
                  p.category === 'other' ? 'var(--hatch-other)' : `var(--cat-${p.category})`,
              }}
              title={`${t(`steps.cat.${p.category}`)} ${formatDuration(p.durationMs)}`}
            />
          ) : null,
        )}
      </div>
      <ul className={css.legend} aria-label={t('steps.phaseShares')}>
        {[...byCat].map(([cat, ms]) => (
          <li key={cat}>
            <span className={css.swatch} data-cat={cat} aria-hidden="true" />
            {t('steps.share', {
              cat: t(`steps.cat.${cat}`),
              pct: `${Math.round((ms / total) * 100)}%`,
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ListProps {
  phases: Phase[];
  follow: boolean;
  onUserScrollAway(): void;
  onOpen(requestId: string): void;
  /** The turn is still running: an empty list may yet fill. */
  running: boolean;
}

function StepList({ phases, running, follow, onUserScrollAway, onOpen }: ListProps) {
  const { t, intl } = useI18n();
  const parentRef = useRef<HTMLDivElement>(null);
  useFollowScroll(parentRef, follow, onUserScrollAway);
  const rows = useMemo<Row[]>(
    () =>
      phases.flatMap((phase, i) => [
        { kind: 'phase' as const, phase, key: `phase:${i}` },
        ...phase.steps.map((step) => ({ kind: 'step' as const, step, key: step.requestId })),
      ]),
    [phases],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'phase' ? 44 : 120),
    overscan: 6,
    getItemKey: (i) => rows[i]?.key ?? i,
  });

  // Follow: stay pinned to the newest step as steps arrive (the total height is known up front).
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (follow && el && rows.length > 0) el.scrollTop = el.scrollHeight;
  }, [follow, rows.length]);

  return (
    <div ref={parentRef} className={css.list} data-steps-scroll>
      {rows.length === 0 && (
        <p className={css.empty}>{t(running ? 'steps.empty' : 'steps.emptyDone')}</p>
      )}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className={css.slot}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.kind === 'phase' ? (
                <div className={css.phaseHead} data-phase={row.phase.category}>
                  <CategoryIcon category={row.phase.category} size={16} />
                  <h3>
                    {t('steps.catCount', {
                      cat: t(`steps.cat.${row.phase.category}`),
                      n: row.phase.steps.length,
                    })}
                  </h3>
                  <span className="num">{formatDuration(row.phase.durationMs)}</span>
                  <span className="num">
                    {t('common.tokens', { n: formatNumber(row.phase.tokens, intl) })}
                  </span>
                </div>
              ) : (
                <StepItem step={row.step} onOpen={onOpen} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
