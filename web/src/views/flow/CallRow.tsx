import { Clock3 } from 'lucide-react';
import { Fragment, memo } from 'react';
import type { ModelRequest, ToolCall } from '../../../../src/core/model.js';
import { StatusPill, Ticking } from '../../components/Status';
import { useApprovalsContext } from '../../data/approvals';
import { useSessionAgent } from '../../data/session-agent';
import type { OpenSession } from '../../data/store';
import { useI18n } from '../../i18n';
import { DASH, formatClock, formatDuration, formatNumber } from '../../lib/format';
import css from './CallRow.module.css';
import { Arrow, type CardKey, FinalReply, RequestCard, ResponseCard, ToolCard } from './cards';
import { DetailPanel } from './DetailPanel';
import { callStatus, requestDurationMs, startUnknown, tokenHeader } from './flow-model';

interface Props {
  req: ModelRequest;
  tools: ToolCall[];
  open: OpenSession;
  focused: boolean;
  selected: CardKey | null;
  onSelect(req: ModelRequest, card: CardKey): void;
  onEnterAgent(agentId: string): void;
}

export const CallRow = memo(function CallRow(p: Props) {
  const { t, intl } = useI18n();
  const agent = useSessionAgent();
  const { req, tools } = p;
  const status = callStatus(req, tools, useApprovalsContext());
  const tok = tokenHeader(req.usage);
  const n = (v: number) => formatNumber(v, intl);
  const select = (card: CardKey) => p.onSelect(req, card);

  return (
    <article
      className={css.row}
      aria-label={t('flow.callTitle', { n: req.index })}
      data-focused={p.focused || undefined}
    >
      <div className={css.header}>
        <h3 className={css.title}>{t('flow.callTitle', { n: req.index })}</h3>
        <span className={css.meta}>
          <Clock3 size={11} aria-hidden="true" />
          <span className="num">{formatClock(req.startedAt)}</span>
        </span>
        <span className={`${css.meta} num`}>
          {req.status === 'in-flight' && req.startedAt ? (
            <Ticking since={req.startedAt} labelKey="flow.elapsed" />
          ) : startUnknown(req) ? (
            <span title={t('flow.startUnknown', { agent })}>{DASH}</span>
          ) : (
            formatDuration(requestDurationMs(req, Date.now()))
          )}
        </span>
        {tok && (
          <span className={`${css.meta} ${css.tokens} num`}>
            <span>{t('flow.input', { n: n(tok.input) })}</span>
            {tok.showUncached && <span>{t('flow.uncached', { n: n(tok.uncached) })}</span>}
            {tok.cacheRead > 0 && <span>{t('flow.cacheRead', { n: n(tok.cacheRead) })}</span>}
            {tok.cacheWrite > 0 && <span>{t('flow.cacheWrite', { n: n(tok.cacheWrite) })}</span>}
          </span>
        )}
        {tok && (
          <span className={`${css.meta} num`}>
            {t('flow.output', { n: n(tok.output), thinking: n(tok.thinking) })}
          </span>
        )}
        <StatusPill status={status} />
      </div>
      <div className={css.strip}>
        <RequestCard
          req={req}
          selected={p.selected === 'request'}
          onSelect={() => select('request')}
        />
        <Arrow />
        <ResponseCard
          req={req}
          selected={p.selected === 'response'}
          onSelect={() => select('response')}
        />
        {tools.map((tool) => (
          <Fragment key={tool.id}>
            <Arrow />
            <ToolCard
              tool={tool}
              open={p.open}
              selected={p.selected === `tool:${tool.id}`}
              onSelect={() => select(`tool:${tool.id}`)}
              onEnterAgent={p.onEnterAgent}
            />
          </Fragment>
        ))}
        {tools.length === 0 && req.status !== 'in-flight' && (
          <>
            <Arrow />
            <FinalReply />
          </>
        )}
      </div>
      {p.selected && (
        <DetailPanel
          sessionId={p.open.id}
          req={req}
          tools={tools}
          card={p.selected}
          onClose={() => p.onSelect(req, p.selected as CardKey)}
        />
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
