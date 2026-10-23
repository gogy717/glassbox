import { useMemo } from 'react';
import type { OpenSession } from '../data/store';
import { useNow } from '../data/useNow';
import { useI18n } from '../i18n';
import { summarize } from '../lib/agents';
import { DASH, formatDuration, formatNumber, formatPercent } from '../lib/format';
import { Diagnostics } from './Diagnostics';
import css from './SummaryBar.module.css';

export function SummaryBar({ open, agentId }: { open: OpenSession; agentId: string }) {
  const { t, intl } = useI18n();
  const now = useNow();
  // Counts only change with the data; the clock only moves the running duration.
  const s = useMemo(() => summarize(open, agentId, now), [open, agentId, now]);
  const items: [string, string][] = [
    [t('summary.turns'), formatNumber(s.turns, intl)],
    [t('summary.requests'), formatNumber(s.requests, intl)],
    [t('summary.toolCalls'), formatNumber(s.toolCalls, intl)],
    // Nothing ran yet: no duration rather than "0ms".
    [t('summary.duration'), s.requests === 0 ? DASH : formatDuration(s.activeMs)],
    [t('summary.input'), formatNumber(s.input, intl)],
    [t('summary.cacheHit'), formatPercent(s.cacheHitRate, intl)],
    [t('summary.output'), `${formatNumber(s.output, intl)} (${formatNumber(s.thinking, intl)})`],
  ];
  return (
    <section className={css.bar} aria-label={t('summary.title')}>
      <div className={css.metrics}>
        {items.map(([label, value]) => (
          <div key={label} className={css.metric}>
            <span className={`${css.value} num`} data-value>
              {value}
            </span>
            <span className={css.label}>{label}</span>
          </div>
        ))}
      </div>
      <Diagnostics diagnostics={open.diagnostics} />
    </section>
  );
}
