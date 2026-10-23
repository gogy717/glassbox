import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  CornerDownLeft,
  LoaderCircle,
  ShieldQuestion,
  Workflow,
  X,
} from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import type { AgentNode, ModelRequest, ToolCall, WorkflowRun } from '../../../../src/core/model.js';
import { contextSize, totalTokens } from '../../../../src/core/usage.js';
import { CategoryIcon } from '../../components/CategoryIcon';
import { LiveDot, Ticking } from '../../components/Status';
import { useApprovalsContext } from '../../data/approvals';
import type { OpenSession } from '../../data/store';
import { useI18n } from '../../i18n';
import { subtreeIds } from '../../lib/agents';
import { formatCompact, formatDuration } from '../../lib/format';
import { plainText, resultLine } from '../../lib/preview';
import { mcpTool, summarizeInput, toolCategory } from '../../lib/tool-category';
import css from './cards.module.css';
import { toolStatus } from './flow-model';

export type { CardKey } from '../../router';

interface ShellProps {
  kind: 'request' | 'response' | 'tool';
  icon: ReactNode;
  title: string;
  /** After the title, muted: a tool's category ("· run"). */
  kindWord?: string;
  /** A tool card's category colour (`var(--cat-run)`), for its label. */
  tone?: string;
  selected: boolean;
  onSelect(): void;
  children: ReactNode;
  /** Extra controls below the card button (buttons cannot nest). */
  footer?: ReactNode;
  label?: string;
}

function Card({
  kind,
  icon,
  title,
  kindWord,
  tone,
  selected,
  onSelect,
  children,
  footer,
  label,
}: ShellProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card groups related buttons; it is not a form fieldset
    <div
      className={css.card}
      data-kind={kind}
      data-selected={selected || undefined}
      role="group"
      aria-label={label ?? title}
      style={tone ? ({ '--cat': tone } as CSSProperties) : undefined}
    >
      <button type="button" className={css.hit} aria-pressed={selected} onClick={onSelect}>
        <span className={css.header}>
          {icon}
          <span className={css.title}>{title}</span>
          {kindWord && <span className={css.kindWord}>· {kindWord}</span>}
        </span>
        <span className={css.body}>{children}</span>
      </button>
      {footer}
    </div>
  );
}

export function Arrow() {
  return <ArrowRight size={18} className={css.arrow} aria-hidden="true" />;
}

const hasReplyText = (req: ModelRequest) =>
  req.blocks.some((b) => b.kind === 'text' && b.text.trim() !== '');

interface FinalReplyProps {
  req: ModelRequest;
  /** Whether the call's Response panel is open. */
  expanded: boolean;
  /** That panel, present while expanded. */
  panelId: string;
  onToggle(): void;
}

/**
 * Ends a row that calls no tools. With reply text it toggles the call's Response panel, where
 * the text is; without, it stays a label.
 */
export function FinalReply({ req, expanded, panelId, onToggle }: FinalReplyProps) {
  const { t } = useI18n();
  if (!hasReplyText(req))
    return (
      <span className={css.final} title={t('flow.finalReplyEmpty')}>
        {t('flow.finalReply')}
      </span>
    );
  return (
    <button
      type="button"
      className={css.final}
      aria-expanded={expanded}
      aria-controls={expanded ? panelId : undefined}
      title={t(expanded ? 'flow.hideFinalReply' : 'flow.showFinalReply')}
      onClick={onToggle}
    >
      <ChevronDown size={14} aria-hidden="true" className={css.chevron} />
      {t('flow.finalReply')}
    </button>
  );
}

interface CardProps {
  req: ModelRequest;
  selected: boolean;
  onSelect(): void;
}

interface ResponseCardProps extends CardProps {
  /** Where an in-flight call's thinking clock starts (`thinkingSince`); its start by default. */
  thinkingSince?: string | null;
}

export function RequestCard({ req, selected, onSelect }: CardProps) {
  const { t, intl } = useI18n();
  return (
    <Card
      kind="request"
      icon={<ArrowUpRight size={13} aria-hidden="true" />}
      title={t('flow.request')}
      selected={selected}
      onSelect={onSelect}
    >
      <span className={req.model ? `${css.preview} ${css.mono}` : css.preview}>
        {req.model ?? t('flow.requestContext')}
      </span>
      <span className={css.chips}>
        {req.effort && <span className={css.chip}>{req.effort}</span>}
        {req.usage && (
          <span className={css.chip}>
            {t('flow.chipContext', { n: formatCompact(contextSize(req.usage), intl) })}
          </span>
        )}
      </span>
    </Card>
  );
}

export function ResponseCard({ req, selected, onSelect, thinkingSince }: ResponseCardProps) {
  const { t } = useI18n();
  const text = req.blocks.find((b) => b.kind === 'text')?.text ?? null;
  const thinking = req.blocks.find((b) => b.kind === 'thinking');
  const thinkingMs = req.blocks.reduce(
    (sum, b) => sum + (b.kind === 'thinking' ? (b.durationMs ?? 0) : 0),
    0,
  );
  const inFlight = req.status === 'in-flight';

  let preview: ReactNode;
  if (inFlight && req.startedAt)
    preview = <Ticking since={thinkingSince ?? req.startedAt} labelKey="flow.thinkingNow" />;
  else if (req.error) preview = <span className={css.errorText}>{req.error.message}</span>;
  else if (text) preview = plainText(text);
  else if (thinking?.kind === 'thinking' && thinking.text) preview = plainText(thinking.text);
  else preview = req.toolCallIds.length ? t('flow.toolsOnly') : t('flow.noResponse');

  return (
    <Card
      kind="response"
      icon={
        inFlight ? (
          <LoaderCircle size={13} className="spin" aria-hidden="true" />
        ) : (
          <CornerDownLeft size={13} aria-hidden="true" />
        )
      }
      title={t('flow.response')}
      selected={selected}
      onSelect={onSelect}
    >
      <span className={css.preview}>{preview}</span>
      <span className={css.chips}>
        {inFlight ? (
          <>
            {req.model && <span className={css.chip}>{req.model}</span>}
            {req.effort && <span className={css.chip}>{req.effort}</span>}
          </>
        ) : (
          <>
            {thinking && (
              <span className={css.chip}>
                {t('flow.chipThinking', { t: formatDuration(thinkingMs || null) })}
              </span>
            )}
            {text && <span className={css.chip}>{t('flow.chipText')}</span>}
            {req.toolCallIds.length > 0 && (
              <span className={css.chip}>{t('flow.chipTools', { n: req.toolCallIds.length })}</span>
            )}
          </>
        )}
      </span>
    </Card>
  );
}

function ResultStrip({ tool }: { tool: ToolCall }) {
  const { t } = useI18n();
  const status = toolStatus(tool, useApprovalsContext());
  let icon: ReactNode;
  let label: ReactNode;
  if (status === 'approval') {
    // Not running yet: the agent is blocked until the person answers the permission prompt.
    icon = <ShieldQuestion size={12} aria-hidden="true" />;
    label = t('status.approval');
  } else if (status === 'running') {
    icon = <LoaderCircle size={12} className="spin" aria-hidden="true" />;
    label = tool.startedAt ? (
      <Ticking since={tool.startedAt} labelKey="flow.runningFor" />
    ) : (
      t('status.running')
    );
  } else if (status === 'error') {
    icon = <X size={12} aria-hidden="true" />;
    label = t('status.error');
  } else if (status === 'complete') {
    icon = <Check size={12} aria-hidden="true" />;
    label =
      (tool.resultPreview &&
        resultLine(tool.resultPreview, (s) =>
          s.size === null
            ? t('flow.json')
            : t(s.kind === 'object' ? 'flow.jsonKeys' : 'flow.jsonItems', { n: s.size }),
        )) ||
      t('status.complete');
  } else {
    icon = <Clock3 size={12} aria-hidden="true" />;
    label = t('status.unknownEnd');
  }
  return (
    <span className={css.result} data-state={status}>
      {/* Announce state changes only; the ticking timer must not be read out every second. */}
      <span className="visually-hidden" aria-live="polite">
        {t(status === 'waiting' ? 'status.unknownEnd' : `status.${status}`)}
      </span>
      {icon}
      <span className={css.resultLabel}>{label}</span>
      {status !== 'running' && status !== 'approval' && (
        <span className="figure">{formatDuration(tool.durationMs)}</span>
      )}
    </span>
  );
}

interface ToolCardProps {
  tool: ToolCall;
  open: OpenSession;
  selected: boolean;
  onSelect(): void;
  onEnterAgent(agentId: string): void;
}

export function ToolCard({ tool, open, selected, onSelect, onEnterAgent }: ToolCardProps) {
  const { t } = useI18n();
  const spawned = tool.spawned;
  let footer: ReactNode = null;
  if (spawned?.kind === 'agent') {
    const agent = open.agents.get(spawned.agentId);
    if (agent) footer = <SpawnedAgents open={open} agents={[agent]} onEnter={onEnterAgent} />;
  } else if (spawned?.kind === 'workflow') {
    const run = open.workflows.get(spawned.runId);
    if (run) footer = <WorkflowBlock run={run} open={open} onEnter={onEnterAgent} />;
  }
  const category = toolCategory(tool.name, tool.input);
  const mcp = mcpTool(tool.name);
  const categoryName = t(`steps.cat.${category}`);
  return (
    <Card
      kind="tool"
      // An MCP tool's title is "server · tool": its plug names the category, so it says it.
      icon={<CategoryIcon category={category} size={13} label={mcp ? categoryName : undefined} />}
      title={mcp ? `${mcp.server} · ${mcp.tool}` : tool.name}
      kindWord={mcp ? undefined : categoryName}
      tone={`var(--cat-${category})`}
      selected={selected}
      onSelect={onSelect}
      footer={footer}
      label={tool.name}
    >
      <span className={`${css.preview} ${css.mono}`}>
        {summarizeInput(tool) || t('flow.runTool')}
      </span>
      <ResultStrip tool={tool} />
    </Card>
  );
}

const MAX_LISTED = 4;

/** Cumulative: the agent's own tokens plus every agent it spawned in turn. */
function cumulativeTokens(open: OpenSession, agentId: string): number {
  let n = 0;
  for (const id of subtreeIds(open, agentId)) {
    const a = open.agents.get(id);
    if (a) n += totalTokens(a.usage);
  }
  return n;
}

function SpawnedAgents({
  open,
  agents,
  onEnter,
}: {
  open: OpenSession;
  agents: AgentNode[];
  onEnter(agentId: string): void;
}) {
  const { t, intl } = useI18n();
  return (
    <span className={css.spawned}>
      {agents.slice(0, MAX_LISTED).map((a) => (
        <button key={a.id} type="button" className={css.agent} onClick={() => onEnter(a.id)}>
          <LiveDot state={a.status} />
          <span className={css.agentLabel}>{a.label}</span>
          <span className={css.agentMeta}>{t(`status.${a.status}`)}</span>
          <span className={`${css.agentMeta} figure`}>
            {formatCompact(cumulativeTokens(open, a.id), intl)}
          </span>
        </button>
      ))}
      {agents.length > MAX_LISTED && (
        <span className={css.more}>{t('flow.moreAgents', { n: agents.length - MAX_LISTED })}</span>
      )}
    </span>
  );
}

function WorkflowBlock({
  run,
  open,
  onEnter,
}: {
  run: WorkflowRun;
  open: OpenSession;
  onEnter(agentId: string): void;
}) {
  const { t } = useI18n();
  const agents = run.agentIds
    .map((id) => open.agents.get(id))
    .filter((a): a is AgentNode => a !== undefined);
  return (
    <span className={css.workflow}>
      <span className={css.workflowName}>
        <Workflow size={12} aria-hidden="true" />
        {run.name ?? run.id}
        <LiveDot state={run.status} label={t(`status.${run.status}`)} />
      </span>
      <span className={css.chips}>
        {run.phases.map((p) => {
          const members = agents.filter((a) => a.phase === p.title);
          const done = members.filter((a) => a.status === 'complete').length;
          return (
            <span key={p.title} className={css.chip} title={p.detail ?? undefined}>
              {t('flow.phaseProgress', { title: p.title, done, total: members.length })}
            </span>
          );
        })}
      </span>
      <SpawnedAgents open={open} agents={agents} onEnter={onEnter} />
    </span>
  );
}
