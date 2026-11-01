import { Receipt } from 'lucide-react';
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CONTEXT_FULL, type ContextUse, contextUse } from '../../../src/shared/context-use.js';
import type { TokenRate } from '../../../src/shared/rate.js';
import { usePriceTable } from '../data/price-table';
import { useCommand } from '../data/shortcuts';
import { type OpenSession, useRate } from '../data/store';
import { useNow } from '../data/useNow';
import { useI18n } from '../i18n';
import { activityStrip } from '../lib/activity';
import { subtreeCost, summarize } from '../lib/agents';
import {
  calendarDays,
  DASH,
  formatCompact,
  formatDuration,
  formatNumber,
  formatPercent,
} from '../lib/format';
import { lazyView } from '../lib/lazy-view';
import { costTitle, formatUsd } from '../lib/prices';
import type { Navigate } from '../router';
import { CompactFigure, UiCjk } from './CompactFigure';
import { Diagnostics } from './Diagnostics';
import { FigureText } from './FigureText';
import { ReceiptBoundary, ReceiptLoading } from './ReceiptEntry';
import css from './SummaryBar.module.css';
import { ActivityStrip, Ring, type RingTone, TokenBars } from './summary/Gauges';
import { rateText } from './TokenRate';
import { Trouble } from './Trouble';

/**
 * What one row of `el`'s children takes: their widths and margins, summed, leaving out the
 * spacer (which takes whatever is free, so the right-hand group's auto margin never does).
 */
function rowWidth(el: HTMLElement): number {
  let width = 0;
  for (const child of el.children) {
    if ((child as HTMLElement).dataset.gap !== undefined) continue;
    const style = getComputedStyle(child);
    width +=
      (child as HTMLElement).offsetWidth +
      (Number.parseFloat(style.marginLeft) || 0) +
      (Number.parseFloat(style.marginRight) || 0);
  }
  return width;
}

/** Below this share of its window, the context ring is muted: nothing to watch yet. */
const CONTEXT_CALM = 0.7;

/** The strip's and the token bars' widths, and what they shrink to when the bar is tight. */
const STRIP_WIDTH = { wide: 200, tight: 150 };
const TRACK_WIDTH = { wide: 100, tight: 80 };

// The receipt's dialog, drawing and export are loaded on first use: the app's first load stays.
const ReceiptDialog = lazyView(() =>
  import('./receipt/ReceiptDialog').then((m) => m.ReceiptDialog),
);

/** Prints the session as a receipt image: the button, and the dialog once it is pressed. */
function ReceiptButton({ open }: { open: OpenSession }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  // Nothing ran yet: nothing to print. Still focusable, so its reason is heard.
  const empty = open.requests.size === 0;
  // The palette's Print receipt, while there is something to print.
  useCommand('receipt', () => setShown(true), !empty);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={css.receipt}
        aria-label={t('receipt.open')}
        aria-haspopup="dialog"
        aria-disabled={empty || undefined}
        title={empty ? t('receipt.nothing') : undefined}
        onClick={() => !empty && setShown(true)}
      >
        <Receipt size={14} aria-hidden="true" />
        <span className={css.receiptLabel} data-word>
          {t('receipt.open')}
        </span>
      </button>
      {shown && (
        <ReceiptBoundary onReset={() => setShown(false)}>
          <Suspense fallback={<ReceiptLoading />}>
            <ReceiptDialog open={open} returnFocusTo={ref} onClose={() => setShown(false)} />
          </Suspense>
        </ReceiptBoundary>
      )}
    </>
  );
}

/**
 * The agent's context as of its latest finished call, as a ring of its model's window where
 * known ("102K of 200K", 50% inside the ring; amber from 85%). Without a window, the count
 * alone. The exact figure is the tooltip and what is read out.
 */
function ContextCell({ use }: { use: ContextUse }) {
  const { t, intl } = useI18n();
  const label = t('context.label');
  if (use.window === null) {
    const exact = formatNumber(use.tokens, intl);
    return (
      <div className={css.cell} data-cell="context" title={t('context.tipUnknown')}>
        <span className="visually-hidden">{t('summary.contextHidden', { exact })}</span>
        <div className={css.stack} aria-hidden="true">
          <span className={css.read}>
            <CompactFigure value={formatCompact(use.tokens, intl)} />
          </span>
          <span className={`${css.label} section-label`}>{label}</span>
        </div>
      </div>
    );
  }
  const share = use.tokens / use.window;
  const pct = new Intl.NumberFormat(intl, { style: 'percent', maximumFractionDigits: 0 }).format(
    Math.floor(share * 100) / 100,
  );
  const tone: RingTone = share >= CONTEXT_FULL ? 'warn' : share < CONTEXT_CALM ? 'muted' : 'plain';
  const exact = `${formatNumber(use.tokens, intl)} ${t('context.of', { window: formatNumber(use.window, intl), pct })}`;
  return (
    <div
      className={css.cell}
      data-cell="context"
      data-tone={tone === 'plain' ? undefined : tone}
      title={t('context.tip', { window: formatCompact(use.window, intl) })}
    >
      <span className="visually-hidden">{t('summary.contextHidden', { exact })}</span>
      <Ring pct={share * 100} tone={tone} />
      <div className={css.stack} aria-hidden="true">
        <span className={css.read}>
          <CompactFigure value={formatCompact(use.tokens, intl)} />
          <span className={css.aside}>
            {' '}
            <UiCjk text={t('summary.ofWindow', { window: formatCompact(use.window, intl) })} />
          </span>
        </span>
        <span className={`${css.label} section-label`}>{label}</span>
      </div>
    </div>
  );
}

/**
 * The readout: the agent's span as an activity strip with its active time, the context and
 * cache-hit rings, the input and output bars, and the API cost; the exact figures in tooltips
 * and for screen readers. Shapes shrink and the right-hand words give way when the bar is tight.
 */
export function SummaryBar({
  open,
  agentId,
  rate: given,
  rateAgent = null,
  navigate,
}: {
  open: OpenSession;
  agentId: string;
  /** The machine's token rate, for its cell on narrow screens; the store's when not given. */
  rate?: TokenRate | null;
  rateAgent?: string | null;
  /** Where a sign of trouble's link goes; without it, the signs are words only. */
  navigate?: Navigate;
}) {
  const { t, intl } = useI18n();
  const stored = useRate();
  const rate = given !== undefined ? given : stored;
  const now = useNow();
  // Whether the bar's own width holds every cell and the diagnostics on one row: when not, the
  // strip and the bars shrink and the right-hand words go; short of room even then, the bar
  // wraps to a second row. The width is the window's less the sidebar's, and the figures grow
  // with the session, so it is measured after each render and on resize. Not tight, the cells'
  // widths summed are what one row needs (the bar wraps, so its scroll width says nothing);
  // tight, that last measure says whether it has grown enough to widen again.
  const bar = useRef<HTMLElement>(null);
  const need = useRef(0);
  const [tight, setTight] = useState(false);
  const [resized, setResized] = useState(0);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el || el.clientWidth === 0) return;
    if (!tight) need.current = rowWidth(el);
    setTight(el.clientWidth < need.current);
  });
  useEffect(() => {
    const el = bar.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setResized((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  void resized;
  // Counts only change with the data; the clock only moves the running duration.
  const s = useMemo(() => summarize(open, agentId, now), [open, agentId, now]);
  const strip = useMemo(() => activityStrip(open, agentId, now), [open, agentId, now]);
  const prices = usePriceTable();
  const cost = useMemo(() => subtreeCost(open, agentId, prices), [open, agentId, prices]);
  const use = useMemo(() => contextUse(open.requests.values(), agentId), [open, agentId]);
  // Nothing ran yet: no active time rather than "0ms". A session that ran over several days
  // says so beside it.
  const active = s.requests === 0 ? DASH : formatDuration(s.activeMs);
  const days = s.span ? calendarDays(s.span.start, s.span.end) : 1;
  const cached = s.cacheHitRate !== null ? s.cacheHitRate * s.input : 0;
  const count = (n: number) => formatNumber(n, intl);
  const tokens = (n: number) => (s.measured ? count(n) : DASH);
  const costText = cost.priced ? `≈ ${formatUsd(cost.usd, intl)}` : DASH;
  const label = (k: Parameters<typeof t>[0]) => (
    <span className={`${css.label} section-label`}>{t(k)}</span>
  );
  return (
    <section
      ref={bar}
      className={css.bar}
      aria-label={t('summary.title')}
      data-tight={tight || undefined}
    >
      <div className={css.cell} data-cell="activity">
        <span className="visually-hidden">
          {t('summary.strip', {
            turns: s.turns,
            calls: s.requests,
            tools: s.toolCalls,
            time: active,
          })}
        </span>
        <div className={css.stack} aria-hidden="true">
          <ActivityStrip strip={strip} width={tight ? STRIP_WIDTH.tight : STRIP_WIDTH.wide} />
          <div className={css.legend}>
            <span>
              <i className={css.tri} />
              {count(s.turns)}
            </span>
            <span>
              <i className={css.barGlyph} />
              {count(s.requests)}
            </span>
            <span>
              <i className={css.tick} />
              {count(s.toolCalls)}
            </span>
          </div>
        </div>
        <div className={css.stack} aria-hidden="true">
          <span className={css.read}>
            <span className="figure">{active}</span>
            {s.requests > 0 && days > 1 && (
              <span className={css.aside}>
                {' '}
                · <FigureText k="summary.overDays" params={{ n: days }} />
              </span>
            )}
          </span>
          {label('summary.active')}
        </div>
      </div>
      {use && <ContextCell use={use} />}
      <div
        className={css.cell}
        data-cell="cache"
        title={
          s.cacheHitRate !== null
            ? t('summary.cacheRing', {
                pct: formatPercent(s.cacheHitRate, intl),
                input: count(s.input),
              })
            : undefined
        }
      >
        <span className="visually-hidden">
          {s.cacheHitRate !== null
            ? t('summary.cacheRing', {
                pct: formatPercent(s.cacheHitRate, intl),
                input: count(s.input),
              })
            : `${t('summary.cacheHit')} ${DASH}`}
        </span>
        {s.cacheHitRate !== null ? (
          <Ring pct={s.cacheHitRate * 100} tone="ok" />
        ) : (
          <span className={`${css.read} figure`} aria-hidden="true">
            {DASH}
          </span>
        )}
        <span aria-hidden="true">{label('summary.cacheHit')}</span>
      </div>
      <div className={css.cell} data-cell="tokens">
        <span className="visually-hidden">
          {t('summary.tokensHidden', {
            input: tokens(s.input),
            cached: tokens(cached),
            output: tokens(s.output),
            thinking: tokens(s.thinking),
          })}
        </span>
        <TokenBars
          input={s.input}
          cached={cached}
          output={s.output}
          thinking={s.thinking}
          measured={s.measured}
          intl={intl}
          width={tight ? TRACK_WIDTH.tight : TRACK_WIDTH.wide}
          labels={{ in: t('summary.in'), out: t('summary.out') }}
        />
      </div>
      {/* What the same tokens would cost on the API: an estimate, so "≈", and a dash when no
          model used has a price. */}
      <div className={css.cell} data-cell="cost" title={costTitle(cost, t)}>
        <span className="visually-hidden">{t('summary.costHidden', { cost: costText })}</span>
        <div className={css.stack} aria-hidden="true">
          <span className={`${css.read} figure`}>{costText}</span>
          {label('summary.api')}
        </div>
      </div>
      {/* The token rate lives in the top bar until it gives it up, below 900px. */}
      {rate && (
        <div className={css.cell} data-cell="rate" data-narrow-only>
          <span className="visually-hidden">
            {t('summary.rate')} {rateText(rate, rateAgent, intl, t('rate.perMin'))}
          </span>
          <div className={css.stack} aria-hidden="true">
            <span className={`${css.read} figure`}>
              {/* "≈9万/分钟" in Chinese: its CJK out of the figure's mono face. */}
              <UiCjk text={rateText(rate, rateAgent, intl, t('rate.perMin'))} />
            </span>
            {label('summary.rate')}
          </div>
        </div>
      )}
      <span className={css.gap} data-gap aria-hidden="true" />
      {/* One group, so short of room it moves to the next row whole, at the right. */}
      <div className={css.side}>
        <Diagnostics diagnostics={open.diagnostics} />
        <Trouble open={open} agentId={agentId} now={now} navigate={navigate} />
        <ReceiptButton open={open} />
      </div>
    </section>
  );
}
