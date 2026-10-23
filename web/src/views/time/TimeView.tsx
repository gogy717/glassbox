import { Timer, Wrench } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { MAIN_AGENT_ID } from '../../../../src/core/model.js';
import { useApprovalsContext } from '../../data/approvals';
import type { OpenSession } from '../../data/store';
import { useNow } from '../../data/useNow';
import { useThrottled } from '../../data/useThrottled';
import { type MessageKey, useI18n } from '../../i18n';
import { subtreeIds } from '../../lib/agents';
import { formatDuration } from '../../lib/format';
import { slowest, timeBreakdown, timeSegments } from '../../lib/time-stats';
import { summarizeInput, type ToolCategory } from '../../lib/tool-category';
import type { Navigate } from '../../router';
import { useUi } from '../../ui';
import { Swimlanes } from './Swimlanes';
import css from './TimeView.module.css';

interface Props {
  open: OpenSession;
  agentId: string;
  navigate: Navigate;
}

function isLive(open: OpenSession): boolean {
  for (const r of open.requests.values()) if (r.status === 'in-flight') return true;
  for (const t of open.toolCalls.values()) if (t.status === 'running') return true;
  return false;
}

const TOOL_ORDER: ToolCategory[] = [
  'explore',
  'edit',
  'run',
  'delegate',
  'ask',
  'plan',
  'web',
  'other',
];
const SLOWEST_N = 10;

export function TimeView({ open, agentId, navigate }: Props) {
  const { t } = useI18n();
  const { setFollow } = useUi();
  // Rebuilding every lane costs tens of ms on a big session: at most once a second, and only
  // tick the clock while something is still running.
  const view = useThrottled(open, 1000);
  const live = useMemo(() => isLive(view), [view]);
  const now = useNow(live ? 1000 : 60_000);
  const approvals = useApprovalsContext();
  const lanes = useMemo(() => timeSegments(view, now, approvals), [view, now, approvals]);
  const breakdown = useMemo(
    () => timeBreakdown(view, agentId, now, approvals),
    [view, agentId, now, approvals],
  );
  const slow = useMemo(
    () => slowest(view, subtreeIds(view, agentId), now, SLOWEST_N),
    [view, agentId, now],
  );
  const name = (id: string) =>
    id === MAIN_AGENT_ID ? t('crumb.main') : (open.agents.get(id)?.label ?? id);

  const openRequest = useCallback(
    (requestId: string) => {
      const req = open.requests.get(requestId);
      if (!req) return;
      setFollow(false);
      navigate({ tab: 'flow', agentId: req.agentId, turnId: req.turnId, requestId: req.id });
    },
    [open, navigate, setFollow],
  );

  const parts: { key: string; label: string; ms: number; color: string }[] = [
    {
      key: 'thinking',
      label: t('time.thinking'),
      ms: breakdown.model.thinking,
      color: 'var(--seg-thinking)',
    },
    {
      key: 'generating',
      label: t('time.generating'),
      ms: breakdown.model.generating,
      color: 'var(--seg-generating)',
    },
    {
      key: 'waiting',
      label: t('time.waiting'),
      ms: breakdown.model.waiting,
      color: 'var(--seg-waiting)',
    },
    ...TOOL_ORDER.map((c) => ({
      key: `tool-${c}`,
      label: t('time.toolCat', { cat: t(`steps.cat.${c}` as MessageKey) }),
      ms: breakdown.tools[c] ?? 0,
      color: `var(--cat-${c})`,
    })),
    { key: 'idle', label: t('time.idle'), ms: breakdown.idle, color: 'var(--hatch-idle)' },
    {
      key: 'approval',
      label: t('time.approval'),
      ms: breakdown.approval,
      color: 'var(--seg-approval)',
    },
  ].filter((p) => p.ms > 0);
  const total = parts.reduce((s, p) => s + p.ms, 0);

  if (lanes.every((l) => l.segments.length === 0))
    return <p className={css.empty}>{t('time.empty')}</p>;

  return (
    <div className={css.view}>
      <div className={css.columns}>
        <section className={css.card} aria-labelledby="time-breakdown">
          <h3 id="time-breakdown">{t('time.breakdown', { agent: name(agentId) })}</h3>
          {total > 0 && (
            <div className={css.bar} aria-hidden="true">
              {parts.map((p) => (
                <span
                  key={p.key}
                  style={{ flexGrow: p.ms, background: p.color }}
                  title={`${p.label} ${formatDuration(p.ms)}`}
                />
              ))}
            </div>
          )}
          <ul className={css.legend}>
            {parts.map((p) => (
              <li key={p.key}>
                <span className={css.swatch} style={{ background: p.color }} aria-hidden="true" />
                <span className={css.legendLabel}>{p.label}</span>
                <span className={`${css.legendValue} num`}>{formatDuration(p.ms)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className={css.card} aria-labelledby="time-slowest">
          <h3 id="time-slowest">{t('time.slowest', { n: slow.length })}</h3>
          <ol className={css.slowList}>
            {slow.map((s) => {
              const req = open.requests.get(s.requestId);
              const tool = s.kind === 'tool' ? open.toolCalls.get(s.id) : undefined;
              return (
                <li key={`${s.kind}:${s.id}`}>
                  <button
                    type="button"
                    className={css.slowRow}
                    onClick={() => openRequest(s.requestId)}
                  >
                    {s.kind === 'tool' ? (
                      <Wrench size={13} aria-hidden="true" />
                    ) : (
                      <Timer size={13} aria-hidden="true" />
                    )}
                    <span className={css.slowWho}>
                      <span className={css.slowAgent}>{name(s.agentId)}</span>
                      <span className={css.slowWhat}>
                        {s.kind === 'tool'
                          ? [s.name, tool && summarizeInput(tool)].filter(Boolean).join(' · ')
                          : t('tokens.requestRef', {
                              turn: (req?.turnId && open.turns.get(req.turnId)?.index) || '—',
                              n: req?.index ?? '—',
                            })}
                        {s.live && <em> · {t('time.live')}</em>}
                      </span>
                    </span>
                    <span className={`${css.slowDur} num`}>{formatDuration(s.durationMs)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      </div>

      <Swimlanes
        open={open}
        lanes={lanes}
        now={now}
        selectedAgentId={agentId}
        agentName={name}
        onPick={openRequest}
      />
    </div>
  );
}
