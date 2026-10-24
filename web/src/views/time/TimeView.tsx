import { Timer } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { MAIN_AGENT_ID } from '../../../../src/core/model.js';
import { CategoryIcon } from '../../components/CategoryIcon';
import { FigureText } from '../../components/FigureText';
import { useApprovalsContext } from '../../data/approvals';
import type { OpenSession } from '../../data/store';
import { useNow } from '../../data/useNow';
import { useThrottled } from '../../data/useThrottled';
import { type MessageKey, useI18n } from '../../i18n';
import { mayStillRun, subtreeIds } from '../../lib/agents';
import { DASH, fitSummary, formatDuration } from '../../lib/format';
import { activeMs, slowest, timeBreakdown, timeSegments } from '../../lib/time-stats';
import { summarizeInput, type ToolCategory, toolCategory } from '../../lib/tool-category';
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
  'git',
  'web',
  'mcp',
  'other',
];
const SLOWEST_N = 10;
/** Characters of a path in the slowest list before it is cut in the middle. */
const PATH_CHARS = 48;

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
      // Lands on the request's card, open, as a link to it does.
      navigate({
        tab: 'flow',
        agentId: req.agentId,
        turnId: req.turnId,
        requestId: req.id,
        card: 'request',
      });
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
  // The same figure as the agent's lane total, so the two never disagree; a dash, not 0ms, for
  // an agent with nothing timed.
  const segments = lanes.find((l) => l.agentId === agentId)?.segments ?? [];
  const active = segments.length > 0 ? formatDuration(activeMs(segments)) : DASH;

  if (lanes.every((l) => l.segments.length === 0))
    // "Yet" only while the session may still add to it.
    return (
      <p className={css.empty}>{t(mayStillRun(view, agentId) ? 'time.empty' : 'time.emptyDone')}</p>
    );

  return (
    <div className={css.view}>
      {/* The view's namesake first; the summaries below it vary in height. */}
      <Swimlanes
        open={open}
        lanes={lanes}
        now={now}
        selectedAgentId={agentId}
        agentName={name}
        onPick={openRequest}
      />

      <div className={css.columns}>
        <section className={css.section} aria-labelledby="time-breakdown">
          <h3 id="time-breakdown">
            {t('time.breakdown')} <span className={css.headAgent}>· {name(agentId)}</span>
          </h3>
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
                <span className={`${css.legendValue} figure`}>{formatDuration(p.ms)}</span>
              </li>
            ))}
          </ul>
          <p className={css.active}>
            <span>{t('time.activeTime')}</span>
            <span className="figure">{active}</span>
          </p>
        </section>

        <section className={css.section} aria-labelledby="time-slowest">
          <h3 id="time-slowest">{t('time.slowest', { n: slow.length })}</h3>
          <ol className={css.slowList}>
            {slow.map((s) => {
              const req = open.requests.get(s.requestId);
              const tool = s.kind === 'tool' ? open.toolCalls.get(s.id) : undefined;
              const summary = tool && fitSummary(summarizeInput(tool), PATH_CHARS);
              return (
                <li key={`${s.kind}:${s.id}`}>
                  <button
                    type="button"
                    className={css.slowRow}
                    data-live={s.live || undefined}
                    onClick={() => openRequest(s.requestId)}
                  >
                    {tool ? (
                      <CategoryIcon category={toolCategory(tool.name, tool.input)} />
                    ) : (
                      <Timer size={14} aria-hidden="true" />
                    )}
                    <span className={css.slowWho}>
                      <span className={css.slowAgent}>{name(s.agentId)}</span>
                      <span className={css.slowWhat}>
                        {s.kind === 'tool' ? (
                          <>
                            {s.name}
                            {summary && (
                              <>
                                {' · '}
                                <code title={summarizeInput(tool)}>{summary}</code>
                              </>
                            )}
                          </>
                        ) : (
                          <FigureText
                            k="tokens.requestRef"
                            params={{
                              turn: (req?.turnId && open.turns.get(req.turnId)?.index) || '—',
                              n: req?.index ?? '—',
                            }}
                          />
                        )}
                        {s.live && (
                          <>
                            {' · '}
                            <em>{t('time.live')}</em>
                          </>
                        )}
                      </span>
                    </span>
                    <span className={`${css.slowDur} figure`}>{formatDuration(s.durationMs)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </div>
  );
}
