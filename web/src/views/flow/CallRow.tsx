import { memo, type ReactNode, useId } from 'react';
import type { ModelRequest, ToolCall } from '../../../../src/core/model.js';
import { CompactFigure } from '../../components/CompactFigure';
import { FigureText } from '../../components/FigureText';
import { StatusMark, Ticking } from '../../components/Status';
import { useApprovalsContext } from '../../data/approvals';
import { useSessionAgent } from '../../data/session-agent';
import type { OpenSession } from '../../data/store';
import { useI18n } from '../../i18n';
import { DASH, formatClock, formatCompact, formatDuration, formatNumber } from '../../lib/format';
import css from './CallRow.module.css';
import { Arrow, type CardKey, FinalReply, RequestCard, ResponseCard, ToolCard } from './cards';
import { DetailPanel } from './DetailPanel';
import { callStatus, requestDurationMs, startUnknown, tokenHeader } from './flow-model';
import { thinkingClock, whyLine } from './why';

interface Props {
  req: ModelRequest;
  tools: ToolCall[];
  open: OpenSession;
  focused: boolean;
  selected: CardKey | null;
  onSelect(req: ModelRequest, card: CardKey): void;
  onEnterAgent(agentId: string): void;
  /** Opens a call's card, wherever it is: a result in the request's context links to its call. */
  onOpenCall?(call: ToolCall): void;
}

/** A word and its compact figure ("context 195K", "上下文 19.5万"): a CJK unit out of the mono face. */
function Reading({ word, n, children }: { word: string; n: string; children?: ReactNode }) {
  return (
    <span className={css.reading}>
      <span className={css.word}>{word}</span> <CompactFigure value={n} />
      {children}
    </span>
  );
}

/**
 * The call's reason, on the line under its readings: what it said, else what it thought. While
 * it is still thinking with nothing to show, how long it has been at it; nothing while one of
 * its tools runs, whose card counts that time.
 */
function WhyLine({ req, tools }: { req: ModelRequest; tools: ToolCall[] }) {
  const why = whyLine(req);
  const since = thinkingClock(req, tools);
  if (!why && !since) return null;
  return (
    <p className={css.why}>
      {why ?? (since && <Ticking since={since} labelKey="flow.thinkingNow" />)}
    </p>
  );
}

export const CallRow = memo(function CallRow(p: Props) {
  const { t, intl } = useI18n();
  const agent = useSessionAgent();
  const { req, tools } = p;
  const status = callStatus(req, tools, useApprovalsContext());
  const tok = tokenHeader(req.usage);
  const n = (v: number) => formatNumber(v, intl);
  const compact = (v: number) => formatCompact(v, intl);
  const select = (card: CardKey) => p.onSelect(req, card);
  const panelId = useId();
  // The line leads with what matters: the context read, what of it was new to the cache, and the
  // output. The whole split is the line's tooltip, and the request panel's "Usage & timing".
  const breakdown =
    tok &&
    [
      `${t('flow.input')} ${n(tok.input)}`,
      tok.showUncached ? `${t('flow.uncached')} ${n(tok.uncached)}` : null,
      tok.cacheRead > 0 ? `${t('flow.cacheRead')} ${n(tok.cacheRead)}` : null,
      tok.cacheWrite > 0 ? `${t('flow.cacheWrite')} ${n(tok.cacheWrite)}` : null,
      `${t('flow.output')} ${n(tok.output)}${
        tok.thinking > 0 ? ` (${t('flow.thinkingOf', { n: n(tok.thinking) })})` : ''
      }`,
    ]
      .filter((part) => part !== null)
      .join(' · ');

  return (
    <article
      className={css.row}
      aria-label={t('flow.callTitle', { n: req.index })}
      data-focused={p.focused || undefined}
    >
      <div className={css.header}>
        {/* One line of readings: figures in the mono face, the words that name them muted. */}
        <div className={css.line}>
          <h3 className={`${css.title} figure`} aria-label={t('flow.callTitle', { n: req.index })}>
            #{req.index}
          </h3>
          <span className={`${css.meta} figure`}>{formatClock(req.startedAt)}</span>
          {/* Ticking sets its own clock as a figure; its words ("已") stay in the UI face. */}
          <span className={css.meta}>
            {req.status === 'in-flight' && req.startedAt ? (
              <Ticking since={req.startedAt} labelKey="flow.elapsed" />
            ) : startUnknown(req) ? (
              <span className="figure" title={t('flow.startUnknown', { agent })}>
                {DASH}
              </span>
            ) : (
              <span className="figure">{formatDuration(requestDurationMs(req, Date.now()))}</span>
            )}
          </span>
          {tok && (
            <span className={css.readings} title={breakdown ?? undefined}>
              <Reading word={t('flow.context')} n={compact(tok.input)} />
              {/* With no cache in play every token was new: the context figure says it all. */}
              {tok.showUncached && <Reading word={t('flow.fresh')} n={compact(tok.fresh)} />}
              <Reading word={t('flow.output')} n={compact(tok.output)}>
                {tok.thinking > 0 && (
                  <span className={css.word}>
                    {' ('}
                    <FigureText k="flow.thinkingOf" params={{ n: compact(tok.thinking) }} />)
                  </span>
                )}
              </Reading>
            </span>
          )}
          <span className={css.status}>
            <StatusMark status={status} />
          </span>
        </div>
        <WhyLine req={req} tools={tools} />
      </div>
      {/* Wraps instead of scrolling: each arrow moves to the next line with its card. */}
      <div className={css.strip}>
        <RequestCard
          req={req}
          selected={p.selected === 'request'}
          onSelect={() => select('request')}
        />
        <div className={css.step}>
          <Arrow />
          <ResponseCard
            req={req}
            selected={p.selected === 'response'}
            onSelect={() => select('response')}
            thinkingSince={thinkingClock(req, tools)}
          />
        </div>
        {tools.map((tool) => (
          <div key={tool.id} className={css.step}>
            <Arrow />
            <ToolCard
              tool={tool}
              open={p.open}
              selected={p.selected === `tool:${tool.id}`}
              onSelect={() => select(`tool:${tool.id}`)}
              onEnterAgent={p.onEnterAgent}
            />
          </div>
        ))}
        {tools.length === 0 && req.status !== 'in-flight' && (
          <div className={css.step}>
            <Arrow />
            {/* The reply is the response's text: the pill opens the Response card's panel. */}
            <FinalReply
              req={req}
              expanded={p.selected === 'response'}
              panelId={panelId}
              onToggle={() => select('response')}
            />
          </div>
        )}
      </div>
      {p.selected && (
        <div id={panelId}>
          <DetailPanel
            sessionId={p.open.id}
            req={req}
            tools={tools}
            card={p.selected}
            onClose={() => p.onSelect(req, p.selected as CardKey)}
            calls={p.open.toolCalls}
            onOpenCall={p.onOpenCall}
          />
        </div>
      )}
    </article>
  );
}, sameRow);

/**
 * Store patches rebuild `open` and the tool arrays even when this row's data is unchanged, so a
 * plain memo never hits. Compare what the row actually shows.
 */
function sameRow(a: Props, b: Props): boolean {
  return (
    a.req === b.req &&
    a.focused === b.focused &&
    a.selected === b.selected &&
    a.onSelect === b.onSelect &&
    a.onEnterAgent === b.onEnterAgent &&
    a.onOpenCall === b.onOpenCall &&
    a.tools.length === b.tools.length &&
    a.tools.every((t, i) => t === b.tools[i]) &&
    a.open.id === b.open.id &&
    // Agent and Workflow cards show the spawned agents' status and tokens.
    a.open.agents === b.open.agents &&
    a.open.workflows === b.open.workflows
  );
}
