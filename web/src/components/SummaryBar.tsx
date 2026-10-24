import { useMemo, useState } from 'react';
import type { TokenRate } from '../../../src/shared/rate.js';
import type { OpenSession } from '../data/store';
import { useNow } from '../data/useNow';
import { useI18n } from '../i18n';
import { summarize } from '../lib/agents';
import { DASH, formatDuration, formatNumber, formatPercent } from '../lib/format';
import { Diagnostics } from './Diagnostics';
import css from './SummaryBar.module.css';
import { rateText } from './TokenRate';

interface Figure {
  label: string;
  value: string;
  /** Below 900px, behind "More figures": the bar keeps conversations, calls, duration, output. */
  more?: boolean;
  /** Muted after the value, e.g. the thinking share of output. */
  aside?: string;
  /** Only below 900px, where the top bar gives it up: the token rate. */
  narrowOnly?: boolean;
}

/** The readout: each figure in the mono face above its label, a hairline between them. */
export function SummaryBar({
  open,
  agentId,
  rate = null,
  rateAgent = null,
}: {
  open: OpenSession;
  agentId: string;
  /** The machine's token rate, for its figure on narrow screens. */
  rate?: TokenRate | null;
  rateAgent?: string | null;
}) {
  const { t, intl } = useI18n();
  const now = useNow();
  const [more, setMore] = useState(false);
  // Counts only change with the data; the clock only moves the running duration.
  const s = useMemo(() => summarize(open, agentId, now), [open, agentId, now]);
  // No call reported usage yet (Grok before a turn total): unknown, not zero.
  const tokens = (n: number) => (s.measured ? formatNumber(n, intl) : DASH);
  const figures: Figure[] = [
    { label: t('summary.turns'), value: formatNumber(s.turns, intl) },
    { label: t('summary.requests'), value: formatNumber(s.requests, intl) },
    { label: t('summary.toolCalls'), value: formatNumber(s.toolCalls, intl), more: true },
    // Nothing ran yet: no duration rather than "0ms".
    {
      label: t('summary.duration'),
      value: s.requests === 0 ? DASH : formatDuration(s.activeMs),
    },
    { label: t('summary.input'), value: tokens(s.input), more: true },
    { label: t('summary.cacheHit'), value: formatPercent(s.cacheHitRate, intl), more: true },
    {
      label: t('summary.output'),
      value: tokens(s.output),
      aside: s.measured ? `(${formatNumber(s.thinking, intl)})` : undefined,
    },
  ];
  if (rate)
    figures.push({
      label: t('summary.rate'),
      value: rateText(rate, rateAgent, intl, t('rate.perMin')),
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
          >
            <span className={`${css.value} figure`} data-value>
              {f.value}
              {f.aside && <span className={css.aside}> {f.aside}</span>}
            </span>
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
    </section>
  );
}
