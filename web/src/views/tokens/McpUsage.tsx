import { ArrowUpRight, ChevronRight } from 'lucide-react';
import { Fragment, type ReactNode, useCallback, useId, useMemo, useState } from 'react';
import { MAIN_AGENT_ID, type ToolCall } from '../../../../src/core/model.js';
import { FigureText } from '../../components/FigureText';
import { StatusMark } from '../../components/Status';
import type { OpenSession } from '../../data/store';
import { useI18n } from '../../i18n';
import { subtreeIds } from '../../lib/agents';
import { formatClock, formatDuration, formatNumber } from '../../lib/format';
import { type McpServerUse, type McpToolUse, mcpUsage } from '../../lib/mcp-usage';
import type { Navigate } from '../../router';
import { useUi } from '../../ui';
import css from './McpUsage.module.css';

interface Props {
  open: OpenSession;
  agentId: string;
  navigate: Navigate;
}

/** A tool's calls listed before "Show N more". */
const CALLS_SHOWN = 12;

/**
 * "MCP servers", at the end of Where tokens went: what each MCP server the agent called cost at
 * run time (`mcp-usage.ts`), one row a server, unfolding into its tools, each call a link to it
 * in the execution chain. The selected agent's sub-agents are counted too unless left out, as
 * the Files tab does. Nothing at all when none of them called an MCP server.
 */
export function McpUsage({ open, agentId, navigate }: Props) {
  const { t } = useI18n();
  const { setFollow } = useUi();
  const [withSub, setWithSub] = useState(true);
  const subtree = useMemo(() => subtreeIds(open, agentId), [open, agentId]);
  const hasSub = subtree.size > 1;
  const all = useMemo(() => mcpUsage(open.toolCalls.values(), subtree), [open, subtree]);
  const own = useMemo(
    () => (hasSub && !withSub ? mcpUsage(open.toolCalls.values(), new Set([agentId])) : all),
    [open, agentId, hasSub, withSub, all],
  );
  const openCall = useCallback(
    (tool: ToolCall) => {
      setFollow(false);
      // Lands on the call in the execution chain with its card open, as a link does.
      navigate({
        tab: 'flow',
        agentId: tool.agentId,
        turnId: open.requests.get(tool.requestId)?.turnId ?? null,
        requestId: tool.requestId,
        card: `tool:${tool.id}`,
      });
    },
    [open, navigate, setFollow],
  );

  if (all.length === 0) return null;
  const agentName =
    agentId === MAIN_AGENT_ID ? t('crumb.main') : (open.agents.get(agentId)?.label ?? agentId);
  return (
    <section className={css.section} aria-labelledby="tok-mcp">
      <div className={css.head}>
        <h3 id="tok-mcp">
          {t('mcp.title')} <span className={css.agent}>· {agentName}</span>
        </h3>
        {hasSub && (
          <button
            type="button"
            className={css.toggle}
            aria-pressed={withSub}
            onClick={() => setWithSub((on) => !on)}
          >
            {t('mcp.includeSub')}
          </button>
        )}
      </div>
      {own.length === 0 ? (
        <p className={css.note}>{t('mcp.noneAgent')}</p>
      ) : (
        <ul className={css.servers}>
          {own.map((s) => (
            <ServerRow key={s.server} use={s} onOpen={openCall} />
          ))}
        </ul>
      )}
      <p className={css.note}>{t('mcp.note')}</p>
    </section>
  );
}

/** "3 calls · 1 failed · 1 running": counts, the failures in the error tone. */
function Counts({ use }: { use: { calls: number; failures: number; running: number } }) {
  const parts: ReactNode[] = [<FigureText key="calls" k="mcp.calls" params={{ n: use.calls }} />];
  if (use.failures > 0)
    parts.push(
      <span key="failed" className={css.failed}>
        <FigureText k="mcp.failed" params={{ n: use.failures }} />
      </span>,
    );
  if (use.running > 0)
    parts.push(
      <span key="running" className={css.running}>
        <FigureText k="mcp.running" params={{ n: use.running }} />
      </span>,
    );
  return (
    <>
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed line
        <Fragment key={i}>
          {i > 0 && ' · '}
          {p}
        </Fragment>
      ))}
    </>
  );
}

function ServerRow({ use, onOpen }: { use: McpServerUse; onOpen(tool: ToolCall): void }) {
  const { t, intl } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  return (
    <li className={css.server}>
      <button
        type="button"
        className={css.rowHead}
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={() => setExpanded((on) => !on)}
      >
        <ChevronRight size={14} className={css.chevron} aria-hidden="true" />
        <span className={css.what}>
          <span className={css.name}>{use.server}</span>
          <span className={css.meta}>
            <Counts use={use} />
          </span>
        </span>
        <span className={css.time}>
          <span>
            <FigureText k="mcp.total" params={{ time: formatDuration(use.ms) }} />
          </span>
          {use.medianMs !== null && (
            <span className={css.meta}>
              <FigureText k="mcp.median" params={{ time: formatDuration(use.medianMs) }} />
            </span>
          )}
        </span>
        <span
          className={css.tokens}
          title={t('mcp.chars', { n: formatNumber(use.resultChars, intl) })}
        >
          <FigureText k="mcp.tokens" params={{ n: formatNumber(use.tokens, intl) }} />
        </span>
      </button>
      {expanded && (
        <ul id={bodyId} className={css.tools} aria-label={t('mcp.tools', { server: use.server })}>
          {use.tools.map((tool) => (
            <ToolItem key={tool.name} tool={tool} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ToolItem({ tool, onOpen }: { tool: McpToolUse; onOpen(tool: ToolCall): void }) {
  const { t, intl } = useI18n();
  const [all, setAll] = useState(false);
  const nameId = useId();
  const shown = all ? tool.calls : tool.calls.slice(0, CALLS_SHOWN);
  const more = tool.calls.length - shown.length;
  return (
    <li className={css.tool} aria-labelledby={nameId}>
      <div className={css.toolHead}>
        <span id={nameId} className={css.toolName}>
          {tool.name}
        </span>
        <span className={css.meta}>
          <Counts
            use={{ calls: tool.calls.length, failures: tool.failures, running: tool.running }}
          />
          {' · '}
          <FigureText k="mcp.total" params={{ time: formatDuration(tool.ms) }} />
          {' · '}
          <FigureText
            k="mcp.chars"
            params={{ n: formatNumber(tool.resultChars, intl) }}
            figures={['n']}
          />
        </span>
      </div>
      <ol className={css.calls}>
        {shown.map((call) => (
          <li key={call.id}>
            <button
              type="button"
              className={css.call}
              title={t('steps.openInFlow')}
              aria-label={[
                ...(call.status === 'error' || call.status === 'running'
                  ? [t(`status.${call.status}`)]
                  : []),
                formatClock(call.startedAt),
                formatDuration(call.durationMs),
                t('steps.openInFlow'),
              ].join(' · ')}
              onClick={() => onOpen(call)}
            >
              {call.status === 'error' && <StatusMark status="error" compact />}
              {call.status === 'running' && <StatusMark status="running" />}
              <span className="figure">{formatClock(call.startedAt)}</span>
              <span className="figure">{formatDuration(call.durationMs)}</span>
              <ArrowUpRight size={13} className={css.arrow} aria-hidden="true" />
            </button>
          </li>
        ))}
        {more > 0 && (
          <li>
            <button type="button" className={css.more} onClick={() => setAll(true)}>
              {t('mcp.more', { n: more })}
            </button>
          </li>
        )}
      </ol>
    </li>
  );
}
