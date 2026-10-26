import { Fragment, type ReactNode, useMemo, useRef } from 'react';
import { MAIN_AGENT_ID } from '../../../../src/core/model.js';
import type {
  CarriedItem,
  ContextAdvice,
  DroppedPart,
  SessionContextBill,
  TokenSplit,
} from '../../../../src/shared/context-bill.js';
import { shownPath } from '../../../../src/shared/files.js';
import { CompactFigure, UiCjk } from '../../components/CompactFigure';
import { Delayed } from '../../components/Delayed';
import { FigureText } from '../../components/FigureText';
import { fetchContextBill } from '../../data/api';
import { useSessionAgent } from '../../data/session-agent';
import type { OpenSession } from '../../data/store';
import { useFetch } from '../../data/useFetch';
import { type MessageKey, type Params, translateParts, useI18n } from '../../i18n';
import { formatCompact, formatPercent } from '../../lib/format';
import { summarizeInput } from '../../lib/tool-category';
import type { Navigate, Route } from '../../router';
import { useUi } from '../../ui';
import { GROUP } from '../flow/detail/ContextView';
import parts from '../flow/detail/context.module.css';
import css from './ContextBill.module.css';

interface Props {
  open: OpenSession;
  agentId: string;
  navigate: Navigate;
}

const NONE = {
  'not-recorded': 'context.none.notRecorded',
  'no-messages': 'context.none.noMessages',
  empty: 'context.none.empty',
} as const;

const MOSTLY: Record<keyof TokenSplit, MessageKey> = {
  cacheRead: 'context.mostly.cacheRead',
  cacheWrite: 'context.mostly.cacheWrite',
  input: 'context.mostly.input',
};

/** The kind of token most of `split` is, when two thirds or more of it is. */
function mostly(split: TokenSplit, tokens: number): keyof TokenSplit | null {
  const kinds = Object.keys(MOSTLY) as (keyof TokenSplit)[];
  const top = kinds.reduce((a, b) => (split[b] > split[a] ? b : a));
  return tokens > 0 && split[top] / tokens >= 2 / 3 ? top : null;
}

/**
 * "What the context held", in Where tokens went: what the agent's requests carried again and
 * again, from the server's bill of their contexts (`context-bill.ts`), with one line of advice,
 * the system prompt and tools sent with every request, the costliest items, and what each
 * compaction dropped. Asked again as the agent's requests finish, the last answer kept on screen
 * meanwhile. Every figure is an estimate and says so.
 */
export function ContextBill({ open, agentId, navigate }: Props) {
  const { t, intl } = useI18n();
  const agent = useSessionAgent();
  const { setFollow } = useUi();
  const finished = useMemo(() => {
    let n = 0;
    for (const r of open.requests.values())
      if (r.agentId === agentId && r.status !== 'in-flight') n += 1;
    return n;
  }, [open.requests, agentId]);
  const base = `${open.id}\n${agentId}`;
  const [state, retry] = useFetch(`${base}\n${finished}`, (signal) =>
    fetchContextBill(open.id, agentId, signal),
  );
  const last = useRef<{ base: string; bill: SessionContextBill } | null>(null);
  if (state.status === 'ok') last.current = { base, bill: state.data };
  const bill =
    state.status === 'ok' ? state.data : last.current?.base === base ? last.current.bill : null;
  const agentName =
    agentId === MAIN_AGENT_ID ? t('crumb.main') : (open.agents.get(agentId)?.label ?? agentId);

  const go = (to: Partial<Route> | null) => {
    if (!to) return;
    setFollow(false);
    navigate({ tab: 'flow', ...to });
  };
  const toRequest = (id: string): Partial<Route> | null => {
    const req = open.requests.get(id);
    return req
      ? { agentId: req.agentId, turnId: req.turnId, requestId: req.id, card: 'request' }
      : null;
  };
  const toCall = (id: string): Partial<Route> | null => {
    const call = open.toolCalls.get(id);
    const req = call && open.requests.get(call.requestId);
    return req
      ? { agentId: req.agentId, turnId: req.turnId, requestId: req.id, card: `tool:${id}` }
      : null;
  };
  /** An item as the execution chain names it: the tool and what it worked on, else its words. */
  const label = (
    item: CarriedItem | DroppedPart,
    short = false,
  ): { text: string; mono: boolean } => {
    if (item.kind === 'file' && item.path && !short)
      return {
        text: `${item.tool ?? ''} ${shownPath(item.path, open.session.cwd).path}`.trim(),
        mono: true,
      };
    if (item.kind === 'file' || item.kind === 'result' || item.kind === 'call') {
      const call = item.callId ? open.toolCalls.get(item.callId) : undefined;
      const gist = call ? summarizeInput(call) : (item.target ?? '');
      return { text: [item.tool, gist].filter(Boolean).join(' '), mono: true };
    }
    const word =
      item.kind === 'reply'
        ? t('context.kind.reply')
        : item.kind === 'user'
          ? t('context.kind.user')
          : t('context.kind.other', { role: item.role ?? '' });
    return { text: `${word} · ${item.text ?? t('context.thinking')}`, mono: false };
  };
  const approx = (n: number) => `≈${formatCompact(n, intl)}`;

  let body: ReactNode;
  if (!bill) {
    body =
      state.status === 'error' ? (
        <p className={css.message}>
          {t('detail.loadError', { msg: state.message })}{' '}
          <button type="button" className={css.retry} onClick={retry}>
            {t('detail.retry')}
          </button>
        </p>
      ) : (
        <Delayed>
          <p className={css.message}>{t('detail.loading')}</p>
        </Delayed>
      );
  } else if (bill.read === 0) {
    body = (
      <p className={css.message}>
        {bill.requests === 0
          ? t('context.none.noRequests')
          : t(NONE[bill.unavailable ?? 'not-recorded'], { agent })}
      </p>
    );
  } else {
    body = (
      <>
        {bill.advice && (
          <p className={css.advice}>
            <Advice advice={bill.advice} label={(i) => label(i).text} />
          </p>
        )}
        {bill.fixed && (
          <div className={css.fixed}>
            <span className={css.fixedLabel}>
              <FigureText k="context.fixedLabel" params={{ n: bill.fixed.toolCount }} />
            </span>
            <span className={css.fixedValue}>
              <Sentence
                k="context.fixedValue"
                params={{ k: formatCompact(bill.fixed.perRequest, intl), r: bill.fixed.requests }}
                compact={['k']}
              />
            </span>
          </div>
        )}
        <ol className={css.items}>
          {bill.items.map((item) => {
            const { text, mono } = label(item);
            const to = item.callId ? toCall(item.callId) : toRequest(item.firstRequestId);
            const kind = mostly(item.split, item.tokens);
            const name = mono ? <UiCjk text={text} /> : text;
            return (
              <li key={item.key} className={css.item}>
                <span
                  className={parts.swatch}
                  data-group={item.kind === 'file' ? 'results' : GROUP[item.kind]}
                  aria-hidden="true"
                />
                <span className={css.what}>
                  {to ? (
                    <button
                      type="button"
                      className={css.name}
                      data-mono={mono || undefined}
                      onClick={() => go(to)}
                    >
                      {name}
                    </button>
                  ) : (
                    <span className={css.name} data-mono={mono || undefined}>
                      {name}
                    </span>
                  )}
                  <span className={css.meta}>
                    <FigureText k="context.carried" params={{ n: item.requests }} />
                    {item.kind === 'file' && (
                      <>
                        {' · '}
                        <FigureText k="context.reads" params={{ n: item.reads }} />
                      </>
                    )}
                    {kind && ` · ${t(MOSTLY[kind])}`}
                  </span>
                </span>
                <span
                  className={css.tokens}
                  title={[
                    `${t('tokens.cacheRead')} ${formatCompact(item.split.cacheRead, intl)}`,
                    `${t('tokens.cacheWrite')} ${formatCompact(item.split.cacheWrite, intl)}`,
                    `${t('tokens.input')} ${formatCompact(item.split.input, intl)}`,
                  ].join(' · ')}
                >
                  <CompactFigure value={approx(item.tokens)} />
                </span>
              </li>
            );
          })}
        </ol>
        {bill.compactions.length > 0 && (
          <div className={css.compactions}>
            <h4>{t('context.compactions')}</h4>
            <ul className={css.drops}>
              {bill.compactions.map((drop) => {
                const req = open.requests.get(drop.requestId);
                const turn = req?.turnId ? open.turns.get(req.turnId) : undefined;
                const ref = t('tokens.requestRef', {
                  turn: turn?.index ?? '—',
                  n: req?.index ?? '—',
                });
                return (
                  <li key={drop.requestId} className={css.drop}>
                    <button
                      type="button"
                      className={css.dropAt}
                      onClick={() => go(toRequest(drop.requestId))}
                    >
                      {t('context.compactionBefore', { ref })}
                    </button>{' '}
                    <span>
                      <Sentence
                        k="context.compactionDropped"
                        params={{ n: drop.dropped, k: formatCompact(drop.tokens, intl) }}
                        compact={['k']}
                      />
                    </span>
                    {drop.largest.length > 0 && t('context.largestSep')}
                    {drop.largest.map((p, i) => {
                      const { text, mono } = label(p, true);
                      return (
                        <span key={p.key}>
                          {i > 0 && t('context.listSep')}
                          <span className={css.dropName} data-mono={mono || undefined}>
                            {mono ? <UiCjk text={text} /> : text}
                          </span>{' '}
                          <CompactFigure value={approx(p.tokens)} />
                        </span>
                      );
                    })}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <p className={css.note}>{t('context.note', { n: bill.read, total: bill.requests })}</p>
      </>
    );
  }

  return (
    <section className={css.section} aria-labelledby="tok-held">
      <div className={css.head}>
        <h3 id="tok-held">
          {t('context.title')} <span className={css.agent}>· {agentName}</span>
        </h3>
      </div>
      {body}
    </section>
  );
}

/** The advice, in the note style, its figures in the mono face. */
function Advice({ advice: a, label }: { advice: ContextAdvice; label(item: CarriedItem): string }) {
  const { intl } = useI18n();
  if (a.kind === 'rereads')
    return <FigureText k="context.advice.rereads" params={{ n: a.files, k: a.reads }} />;
  if (a.kind === 'carried')
    return (
      <FigureText
        k="context.advice.carried"
        params={{ pct: formatPercent(a.share, intl), label: label(a.item) }}
        figures={['pct']}
      />
    );
  return (
    <Sentence
      k="context.advice.fixed"
      params={{ pct: formatPercent(a.share, intl), k: formatCompact(a.perRequest, intl) }}
      compact={['k']}
    />
  );
}

/**
 * A sentence whose counts are figures in the mono face, its compact ones ("1.92万") with their
 * CJK unit apart, as `CompactFigure` sets them.
 */
function Sentence({
  k,
  params,
  compact = [],
}: {
  k: MessageKey;
  params: Params;
  compact?: readonly string[];
}) {
  const { locale } = useI18n();
  return (
    <>
      {translateParts(locale, k, params).map((p, i) =>
        typeof p === 'string' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <Fragment key={i}>{p}</Fragment>
        ) : compact.includes(p.param) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <CompactFigure key={i} value={p.value} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <span key={i} className="figure">
            {p.value}
          </span>
        ),
      )}
    </>
  );
}
