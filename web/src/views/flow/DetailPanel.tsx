import { ChevronUp, Maximize2 } from 'lucide-react';
import { type ReactNode, useId, useMemo, useRef, useState } from 'react';
import type { ModelRequest, RequestDetail, ToolCall } from '../../../../src/core/model.js';
import type { ToolResultResponse } from '../../../../src/shared/protocol.js';
import { CopyButton } from '../../components/CodeBlock';
import { FigureText } from '../../components/FigureText';
import { JsonInspector } from '../../components/JsonInspector';
import { Markdown } from '../../components/Markdown';
import { Modal } from '../../components/Modal';
import { StatusMark } from '../../components/Status';
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
import { ArgsView } from './detail/ArgsView';
import { useDetailPrefs } from './detail/prefs';
import { KeyValues, RequestReadable } from './detail/RequestReadable';
import { MarkdownToggle, ViewToggle } from './detail/ViewToggle';
import { toolStatus } from './flow-model';

interface Props {
  sessionId: string;
  req: ModelRequest;
  tools: ToolCall[];
  card: CardKey;
  onClose(): void;
}

/** How fully a request's body was reconstructed, as a quiet mark: never a green badge. */
function Completeness({ detail }: { detail: RequestDetail }) {
  const { t } = useI18n();
  const agent = useSessionAgent();
  if (detail.completeness === 'full')
    return <StatusMark status="complete" label={t('detail.full')} />;
  if (detail.completeness === 'partial')
    return <StatusMark status="interrupted" label={t('detail.partial')} />;
  return <StatusMark status="waiting" label={t('detail.unavailable', { agent })} />;
}

/**
 * The panel under a call row for the selected card: what was sent, what came back, what ran.
 * Its head names the card and call, says how complete a request is, and holds the one
 * Readable | JSON switch, copy (what the panel shows, as JSON), maximize and close.
 */
export function DetailPanel({ sessionId, req, tools, card, onClose }: Props) {
  const { t } = useI18n();
  const titleId = useId();
  const maxRef = useRef<HTMLButtonElement>(null);
  const [maximized, setMaximized] = useState(false);
  const tool = card.startsWith('tool:') ? tools.find((x) => `tool:${x.id}` === card) : undefined;
  // Keyed on the status too: what was sent is only final once the request has completed.
  const key = card === 'request' && req.hasDetail ? `${sessionId}\n${req.id}\n${req.status}` : null;
  const [state, retry] = useFetch(key, (signal) => fetchRequestDetail(sessionId, req.id, signal));
  const detail = state.status === 'ok' ? state.data : null;
  // A tool's full result, fetched once on request and shared by the panel, its maximized
  // dialog and Copy.
  const [fullFor, setFullFor] = useState<string | null>(null);
  const fullKey = tool && fullFor === tool.id ? `${sessionId}\n${tool.id}` : null;
  const [full, retryFull] = useFetch(fullKey, (signal) =>
    fetchToolResult(sessionId, tool?.id ?? '', signal),
  );
  const fullResult = full.status === 'ok' ? full.data.result : undefined;
  const title =
    card === 'request'
      ? t('detail.request')
      : card === 'response'
        ? t('detail.response')
        : t('detail.tool');
  const callRef = t('detail.callRef', { n: req.index });
  // Built when Copy is clicked: a request can be megabytes.
  const copyText = () =>
    JSON.stringify(
      card === 'request'
        ? detail
        : tool
          ? { name: tool.name, input: tool.input, result: fullResult ?? tool.resultPreview }
          : { model: req.model, stopReason: req.stopReason, blocks: req.blocks, usage: req.usage },
      null,
      2,
    );
  const body =
    card === 'request' ? (
      <RequestBody req={req} state={state} retry={retry} />
    ) : card === 'response' ? (
      <ResponseBody req={req} />
    ) : tool ? (
      <ToolBody
        tool={tool}
        full={full}
        retryFull={retryFull}
        loadFull={() => setFullFor(tool.id)}
      />
    ) : null;
  const canCopy = card !== 'request' || detail !== null;
  return (
    <section className={css.panel} aria-labelledby={titleId}>
      <div className={css.head}>
        <span id={titleId} className={css.title}>
          {title}
        </span>
        <span className={css.callRef}>
          <FigureText k="detail.callRef" params={{ n: req.index }} />
        </span>
        {detail && <Completeness detail={detail} />}
        <span className={css.headTools}>
          <ViewToggle />
          {canCopy && <CopyButton text={copyText} className={css.icon} />}
          <button
            ref={maxRef}
            type="button"
            className={css.icon}
            aria-label={t('json.maximize')}
            title={t('json.maximize')}
            onClick={() => setMaximized(true)}
          >
            <Maximize2 size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={css.icon}
            aria-label={t('detail.close')}
            title={t('detail.close')}
            onClick={onClose}
          >
            <ChevronUp size={16} aria-hidden="true" />
          </button>
        </span>
      </div>
      {body}
      {maximized && (
        <Modal
          label={`${title} · ${callRef}`}
          returnFocusTo={maxRef}
          onClose={() => setMaximized(false)}
          actions={<ViewToggle />}
        >
          {body}
        </Modal>
      )}
    </section>
  );
}

function Cell({
  title,
  tools,
  children,
}: {
  title: string;
  tools?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={css.cell}>
      {tools ? (
        <div className={css.cellHead}>
          <h4>{title}</h4>
          {tools}
        </div>
      ) : (
        <h4>{title}</h4>
      )}
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

function RequestBody({
  req,
  state,
  retry,
}: {
  req: ModelRequest;
  state: FetchState<RequestDetail>;
  retry(): void;
}) {
  const { t } = useI18n();
  const agent = useSessionAgent();
  const [prefs] = useDetailPrefs();
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
          {d.notes.length > 0 && (
            <ul className={css.notes}>
              {d.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {prefs.view === 'readable' ? (
            <RequestReadable detail={d} />
          ) : (
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
          )}
        </>
      )}
    </Loading>
  );
}

/** A response's usage and timing as one flat list: nested usage fields under "usage.". */
function usageEntries(usage: Record<string, unknown>): [string, unknown][] {
  return Object.entries(usage).flatMap(([k, v]): [string, unknown][] =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.entries(v).map(([k2, v2]): [string, unknown] => [`${k}.${k2}`, v2])
      : [[k, v]],
  );
}

function ResponseBody({ req }: { req: ModelRequest }) {
  const { t, intl } = useI18n();
  const kind = useSessionAgentKind();
  const [prefs] = useDetailPrefs();
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
  const usageList = useMemo(() => usageEntries(usage), [usage]);
  return (
    <div className={`${css.grid} ${css.responseGrid}`}>
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
      <Cell title={t('detail.content')} tools={text ? <MarkdownToggle /> : undefined}>
        {text && prefs.markdown === 'rendered' ? (
          <div className={css.content} data-scroll-region>
            <Markdown text={text} label={t('detail.content')} />
          </div>
        ) : (
          <TextBlock label={t('detail.content')} text={text} />
        )}
      </Cell>
      <Cell title={t('detail.usage')}>
        {prefs.view === 'readable' ? (
          <KeyValues entries={usageList} />
        ) : (
          <JsonInspector label="usage" data={usage} />
        )}
      </Cell>
    </div>
  );
}

function ToolBody({
  tool,
  full,
  retryFull,
  loadFull,
}: {
  tool: ToolCall;
  /** The full result, once asked for: the panel's, so its dialog shows it too. */
  full: FetchState<ToolResultResponse>;
  retryFull(): void;
  loadFull(): void;
}) {
  const { t } = useI18n();
  const approvals = useApprovalsContext();
  const [prefs] = useDetailPrefs();
  const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  const args = useMemo(
    () =>
      tool.input !== null && typeof tool.input === 'object' ? tool.input : { input: tool.input },
    [tool.input],
  );
  return (
    <div className={`${css.grid} ${css.toolGrid}`}>
      <Cell title={t('detail.args')}>
        {prefs.view === 'readable' ? (
          <ArgsView input={tool.input} label={tool.name} />
        ) : (
          <JsonInspector label={tool.name} data={args} />
        )}
      </Cell>
      <Cell title={t('detail.result')}>
        {full.status === 'idle' ? (
          <>
            <TextBlock label={t('detail.result')} text={tool.resultPreview} />
            {tool.hasFullResult && (
              <button type="button" className={css.link} onClick={loadFull}>
                {t('detail.loadFull')}
              </button>
            )}
          </>
        ) : (
          <Loading state={full} retry={retryFull}>
            {(r) => <TextBlock label={t('detail.result')} text={asText(r.result)} />}
          </Loading>
        )}
      </Cell>
      <Cell title={t('detail.timing')}>
        <StatusMark status={toolStatus(tool, approvals)} />
        <ul className={css.timing}>
          <li>{t('detail.started', { t: formatClock(tool.startedAt) })}</li>
          <li>{t('detail.ended', { t: formatClock(tool.endedAt) })}</li>
          <li>{t('detail.duration', { t: formatDuration(tool.durationMs) })}</li>
        </ul>
      </Cell>
    </div>
  );
}
