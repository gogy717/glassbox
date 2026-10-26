import { Receipt } from 'lucide-react';
import type { ReactNode } from 'react';
import { Suspense, useMemo, useRef, useState } from 'react';
import type { TokenRate } from '../../../src/shared/rate.js';
import { useCommand } from '../data/shortcuts';
import { type OpenSession, useRate } from '../data/store';
import { useNow } from '../data/useNow';
import { useI18n } from '../i18n';
import { summarize } from '../lib/agents';
import {
  calendarDays,
  DASH,
  formatCompact,
  formatDuration,
  formatNumber,
  formatPercent,
} from '../lib/format';
import { lazyView } from '../lib/lazy-view';
import { CompactFigure, UiCjk } from './CompactFigure';
import { Diagnostics } from './Diagnostics';
import { FigureText } from './FigureText';
import { ReceiptBoundary, ReceiptLoading } from './ReceiptEntry';
import css from './SummaryBar.module.css';
import { rateText } from './TokenRate';

interface Figure {
  label: string;
  value: ReactNode;
  /** The count in full when `value` is compact ("1.84M"): the tooltip, and what is read out. */
  exact?: string;
  /** Below 900px, behind "More figures": the bar keeps prompts, calls, active time, output. */
  more?: boolean;
  /** Muted after the value: the thinking share of output, the days the active time spans. */
  aside?: ReactNode;
  /** Only below 900px, where the top bar gives it up: the token rate. */
  narrowOnly?: boolean;
}

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
        <span className={css.receiptLabel}>{t('receipt.open')}</span>
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

/** The readout: each figure in the mono face above its label, a hairline between them. */
export function SummaryBar({
  open,
  agentId,
  rate: given,
  rateAgent = null,
}: {
  open: OpenSession;
  agentId: string;
  /** The machine's token rate, for its figure on narrow screens; the store's when not given. */
  rate?: TokenRate | null;
  rateAgent?: string | null;
}) {
  const { t, intl } = useI18n();
  const stored = useRate();
  const rate = given !== undefined ? given : stored;
  const now = useNow();
  const [more, setMore] = useState(false);
  // Counts only change with the data; the clock only moves the running duration.
  const s = useMemo(() => summarize(open, agentId, now), [open, agentId, now]);
  // No call reported usage yet (Grok before a turn total): unknown, not zero. A token count is
  // read compact ("1.84M", "184万"), the exact count in the tooltip and for screen readers.
  const tokens = (n: number) =>
    s.measured ? <CompactFigure value={formatCompact(n, intl)} /> : DASH;
  const exact = (n: number) => (s.measured ? formatNumber(n, intl) : undefined);
  // Active time is the turns' sum; a session that ran over several days says so beside it.
  const days = s.span ? calendarDays(s.span.start, s.span.end) : 1;
  const figures: Figure[] = [
    { label: t('summary.turns'), value: formatNumber(s.turns, intl) },
    { label: t('summary.requests'), value: formatNumber(s.requests, intl) },
    { label: t('summary.toolCalls'), value: formatNumber(s.toolCalls, intl), more: true },
    // Nothing ran yet: no active time rather than "0ms".
    {
      label: t('summary.duration'),
      value: s.requests === 0 ? DASH : formatDuration(s.activeMs),
      aside:
        s.requests > 0 && days > 1 ? (
          <>
            · <FigureText k="summary.overDays" params={{ n: days }} />
          </>
        ) : undefined,
    },
    { label: t('summary.input'), value: tokens(s.input), exact: exact(s.input), more: true },
    { label: t('summary.cacheHit'), value: formatPercent(s.cacheHitRate, intl), more: true },
    {
      label: t('summary.output'),
      value: tokens(s.output),
      exact: s.measured
        ? `${formatNumber(s.output, intl)} (${formatNumber(s.thinking, intl)})`
        : undefined,
      aside: s.measured ? (
        <>
          (<CompactFigure value={formatCompact(s.thinking, intl)} />)
        </>
      ) : undefined,
    },
  ];
  if (rate)
    figures.push({
      label: t('summary.rate'),
      // "≈9万/分钟" in Chinese: its CJK out of the figure's mono face.
      value: <UiCjk text={rateText(rate, rateAgent, intl, t('rate.perMin'))} />,
      more: true,
      narrowOnly: true,
    });
  return (
    <section className={css.bar} aria-label={t('summary.title')} data-more={more || undefined}>
      <div className={css.metrics}>
        {figures.map((f) => (
          <div
            key={f.label}
            className={css.metric}
            data-extra={f.more || undefined}
            data-narrow-only={f.narrowOnly || undefined}
            title={f.exact}
          >
            {/* A compact figure is for the eye; the exact one beside it is what is read out. */}
            <span className={css.value} data-value aria-hidden={f.exact ? 'true' : undefined}>
              <span className="figure">{f.value}</span>
              {f.aside && <span className={css.aside}> {f.aside}</span>}
            </span>
            {f.exact && <span className="visually-hidden">{f.exact}</span>}
            <span className={`${css.label} section-label`}>{f.label}</span>
          </div>
        ))}
        <button
          type="button"
          className={css.more}
          aria-expanded={more}
          onClick={() => setMore(!more)}
        >
          {t(more ? 'summary.fewer' : 'summary.more')}
        </button>
      </div>
      <Diagnostics diagnostics={open.diagnostics} />
      <ReceiptButton open={open} />
    </section>
  );
}
