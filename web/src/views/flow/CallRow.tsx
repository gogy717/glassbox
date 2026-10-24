import { memo, type ReactNode, useId } from 'react';
import type { ModelRequest, ToolCall } from '../../../../src/core/model.js';
import { FigureText } from '../../components/FigureText';
import { StatusMark, Ticking } from '../../components/Status';
import { useApprovalsContext } from '../../data/approvals';
import { useSessionAgent } from '../../data/session-agent';
import type { OpenSession } from '../../data/store';
import { useI18n } from '../../i18n';
import { DASH, formatClock, formatDuration, formatNumber } from '../../lib/format';
import css from './CallRow.module.css';
import { Arrow, type CardKey, FinalReply, RequestCard, ResponseCard, ToolCard } from './cards';
import { DetailPanel } from './DetailPanel';
import { callStatus, requestDurationMs, startUnknown, tokenHeader } from './flow-model';
import { thinkingSince, whyLine } from './why';

interface Props {
  req: ModelRequest;
  tools: ToolCall[];
  open: OpenSession;
  focused: boolean;
  selected: CardKey | null;
  onSelect(req: ModelRequest, card: CardKey): void;
  onEnterAgent(agentId: string): void;
}

function Reading({ word, n, children }: { word: string; n: string; children?: ReactNode }) {
  return (
    <span className={css.reading}>
      <span className={css.word}>{word}</span> <span className="figure">{n}</span>
      {children}
    </span>
  );
}

/**
 * The call's reason, on the line under its readings: what it said, else what it thought. While
 * it is still thinking with nothing to show, how long it has been at it.
 */
function WhyLine({ req, tools }: { req: ModelRequest; tools: ToolCall[] }) {
  const why = whyLine(req);
  const since = req.status === 'in-flight' ? thinkingSince(req, tools) : null;
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
  const select = (card: CardKey) => p.onSelect(req, card);
  const panelId = useId();

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
          <span className={`${css.meta} figure`}>
            {req.status === 'in-flight' && req.startedAt ? (
              <Ticking since={req.startedAt} labelKey="flow.elapsed" />
            ) : startUnknown(req) ? (
              <span title={t('flow.startUnknown', { agent })}>{DASH}</span>
            ) : (
              formatDuration(requestDurationMs(req, Date.now()))
            )}
          </span>
          {tok && (
            <span className={css.readings}>
              <Reading word={t('flow.input')} n={n(tok.input)} />
              {tok.showUncached && <Reading word={t('flow.uncached')} n={n(tok.uncached)} />}
              {tok.cacheRead > 0 && <Reading word={t('flow.cacheRead')} n={n(tok.cacheRead)} />}
              {tok.cacheWrite > 0 && <Reading word={t('flow.cacheWrite')} n={n(tok.cacheWrite)} />}
              <Reading word={t('flow.output')} n={n(tok.output)}>
                {tok.thinking > 0 && (
                  <span className={css.word}>
                    {' ('}
                    <FigureText k="flow.thinkingOf" params={{ n: n(tok.thinking) }} />)
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
            thinkingSince={req.status === 'in-flight' ? thinkingSince(req, tools) : null}
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
    a.tools.length === b.tools.length &&
    a.tools.every((t, i) => t === b.tools[i]) &&
    a.open.id === b.open.id &&
    // Agent and Workflow cards show the spawned agents' status and tokens.
    a.open.agents === b.open.agents &&
    a.open.workflows === b.open.workflows
  );
}
