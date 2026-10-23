import { ChevronUp } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import type { ModelRequest, ToolCall } from '../../../../src/core/model.js';
import { JsonInspector } from '../../components/JsonInspector';
import { StatusPill } from '../../components/Status';
import { TextBlock } from '../../components/TextBlock';
import { fetchRequestDetail, fetchToolResult } from '../../data/api';
import { useApprovalsContext } from '../../data/approvals';
import { useSessionAgent, useSessionAgentKind } from '../../data/session-agent';
import { type FetchState, useFetch } from '../../data/useFetch';
import { useI18n } from '../../i18n';
import { agentName, encryptsThinking } from '../../lib/agent-names';
import { formatClock, formatDuration, formatNumber } from '../../lib/format';
import type { CardKey } from './cards';
import css from './DetailPanel.module.css';
import { toolStatus } from './flow-model';

interface Props {
  sessionId: string;
  req: ModelRequest;
  tools: ToolCall[];
  card: CardKey;
  onClose(): void;
}

/** The panel under a call row for the selected card: what was sent, what came back, what ran. */
export function DetailPanel({ sessionId, req, tools, card, onClose }: Props) {
  const { t } = useI18n();
  const titleId = useId();
  const tool = card.startsWith('tool:') ? tools.find((x) => `tool:${x.id}` === card) : undefined;
  const title =
    card === 'request'
      ? t('detail.request')
      : card === 'response'
        ? t('detail.response')
        : t('detail.tool');
  return (
    <section className={css.panel} aria-labelledby={titleId}>
      <div className={css.head}>
        <span id={titleId} className={css.title}>
          {title}
        </span>
        <button
          type="button"
          className={css.close}
          aria-label={t('detail.close')}
          onClick={onClose}
        >
          <ChevronUp size={16} aria-hidden="true" />
        </button>
      </div>
      {card === 'request' && <RequestBody sessionId={sessionId} req={req} />}
      {card === 'response' && <ResponseBody req={req} />}
      {tool && <ToolBody sessionId={sessionId} tool={tool} />}
    </section>
  );
}

function Cell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={css.cell}>
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function Loading<T>({
  state,
  retry,
  children,
}: {
  state: FetchState<T>;
  retry(): void;
  children(data: T): ReactNode;
}) {
  const { t } = useI18n();
  if (state.status === 'ok') return <>{children(state.data)}</>;
  if (state.status === 'error')
    return (
      <p className={css.message}>
        {t('detail.loadError', { msg: state.message })}{' '}
        <button type="button" className={css.link} onClick={retry}>
          {t('detail.retry')}
        </button>
      </p>
    );
  return <p className={css.message}>{t('detail.loading')}</p>;
}

function RequestBody({ sessionId, req }: { sessionId: string; req: ModelRequest }) {
  const { t } = useI18n();
  const agent = useSessionAgent();
  // Keyed on the status too: what was sent is only final once the request has completed.
  const key = req.hasDetail ? `${sessionId}\n${req.id}\n${req.status}` : null;
  const [state, retry] = useFetch(key, (signal) => fetchRequestDetail(sessionId, req.id, signal));
  const d = state.status === 'ok' ? state.data : null;
  // Stable wrappers: a new object per render would re-clip and re-render the whole tree.
  const trees = useMemo(
    () =>
      d && {
        system: { system: d.system },
        messages: { messages: d.messages },
        tools: { tools: d.tools },
        params: { params: d.params },
      },
    [d],
  );
  if (!req.hasDetail) return <p className={css.message}>{t('detail.unavailable', { agent })}</p>;
  return (
    <Loading state={state} retry={retry}>
      {(d) => (
        <>
          <div className={css.status} data-completeness={d.completeness}>
            <span className={css.badge}>
              {d.completeness === 'full'
                ? t('detail.full')
                : d.completeness === 'partial'
                  ? t('detail.partial')
                  : t('detail.unavailable', { agent })}
            </span>
            {d.notes.length > 0 && (
              <ul className={css.notes}>
                {d.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </div>
          <div className={css.grid}>
            <Cell title={t('detail.system')}>
              <JsonInspector label="system" data={trees?.system} />
            </Cell>
            <Cell title={t('detail.messages')}>
              <JsonInspector label="messages" data={trees?.messages} />
            </Cell>
            <Cell title={t('detail.tools')}>
              <JsonInspector label="tools" data={trees?.tools} />
            </Cell>
            <Cell title={t('detail.params')}>
              <JsonInspector label="params" data={trees?.params} />
            </Cell>
          </div>
        </>
      )}
    </Loading>
  );
}

function ResponseBody({ req }: { req: ModelRequest }) {
  const { t, intl } = useI18n();
  const kind = useSessionAgentKind();
  const thinking = req.blocks.filter((b) => b.kind === 'thinking');
  const thinkingText = thinking
    .map((b) => (b.kind === 'thinking' ? b.text : null))
    .filter(Boolean)
    .join('\n\n');
  const thinkingMs = thinking.reduce(
    (s, b) => s + (b.kind === 'thinking' ? (b.durationMs ?? 0) : 0),
    0,
  );
  const text = req.blocks
    .filter((b) => b.kind === 'text')
    .map((b) => (b.kind === 'text' ? b.text : ''))
    .join('\n\n');
  const usage = useMemo(
    () => ({
      model: req.model,
      effort: req.effort,
      stopReason: req.stopReason,
      usage: req.usage,
      startedAt: req.startedAt,
      firstBlockAt: req.firstBlockAt,
      endedAt: req.endedAt,
      error: req.error,
    }),
    [req],
  );
  return (
    <div className={css.grid}>
      <Cell title={t('detail.thinking')}>
        {thinkingText ? (
          <TextBlock label={t('detail.thinking')} text={thinkingText} />
        ) : (
          <p className={css.message}>
            {thinking.length > 0 && encryptsThinking(kind)
              ? t('detail.thinkingEncrypted', { agent: agentName(kind) })
              : t('detail.noThinking')}
          </p>
        )}
        {thinking.length > 0 && (
          <p className={css.meta}>
            {t('detail.thinkingMeta', {
              t: formatDuration(thinkingMs || null),
              n: formatNumber(req.usage?.thinking ?? null, intl),
            })}
          </p>
        )}
      </Cell>
      <Cell title={t('detail.content')}>
        <TextBlock label={t('detail.content')} text={text} />
      </Cell>
      <Cell title={t('detail.usage')}>
        <JsonInspector label="usage" data={usage} />
      </Cell>
    </div>
  );
}

function ToolBody({ sessionId, tool }: { sessionId: string; tool: ToolCall }) {
  const { t } = useI18n();
  const approvals = useApprovalsContext();
  const [wantFull, setWantFull] = useState(false);
  const [state, retry] = useFetch(wantFull ? `${sessionId}\n${tool.id}` : null, (signal) =>
    fetchToolResult(sessionId, tool.id, signal),
  );
  const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  const args = useMemo(
    () =>
      tool.input !== null && typeof tool.input === 'object' ? tool.input : { input: tool.input },
    [tool.input],
  );
  return (
    <div className={css.grid}>
      <Cell title={t('detail.args')}>
        <JsonInspector label={tool.name} data={args} />
      </Cell>
      <Cell title={t('detail.result')}>
        {state.status === 'idle' ? (
          <>
            <TextBlock label={t('detail.result')} text={tool.resultPreview} />
            {tool.hasFullResult && (
              <button type="button" className={css.link} onClick={() => setWantFull(true)}>
                {t('detail.loadFull')}
              </button>
            )}
          </>
        ) : (
          <Loading state={state} retry={retry}>
            {(r) => <TextBlock label={t('detail.result')} text={asText(r.result)} />}
          </Loading>
        )}
      </Cell>
      <Cell title={t('detail.timing')}>
        <StatusPill status={toolStatus(tool, approvals)} />
        <ul className={css.timing}>
          <li>{t('detail.started', { t: formatClock(tool.startedAt) })}</li>
          <li>{t('detail.ended', { t: formatClock(tool.endedAt) })}</li>
          <li>{t('detail.duration', { t: formatDuration(tool.durationMs) })}</li>
        </ul>
      </Cell>
    </div>
  );
}
