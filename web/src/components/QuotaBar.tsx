import { Gauge } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { QuotaSnapshot, QuotaWindow } from '../../../src/core/model.js';
import { type MessageKey, useI18n } from '../i18n';
import { formatCountdown, formatRelative, formatResetTime } from '../lib/format';
import css from './QuotaBar.module.css';

interface Props {
  quotas: QuotaSnapshot[];
  now: number;
}

type Level = 'ok' | 'warn' | 'danger';
const levelOf = (pct: number): Level => (pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok');

function shortLabel(w: QuotaWindow): string {
  if (w.kind === 'session') return '5h';
  if (w.kind === 'weekly') return '7d';
  if (w.kind === 'weekly-model') return w.model ?? w.id;
  return w.id;
}

const pct = (w: QuotaWindow) => Math.round(Math.min(100, Math.max(0, w.usedPercent)));

/** Where quota numbers can come from, in words; an id not listed here shows as itself. */
const SOURCES: Record<string, MessageKey> = { 'claude-code-cache': 'quota.sourceClaudeCodeCache' };

/** Plan quota at a glance (ClaudeBar-style); click for every window and where the data came from. */
export function QuotaBar({ quotas, now }: Props) {
  const { t, intl } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const shown = quotas.filter((q) => q.windows.length > 0);
  if (shown.length === 0) return null;
  const all = shown.flatMap((q) => q.windows);
  // Past its reset time the cached percentage is history: never show it as current usage.
  const isReset = (w: QuotaWindow) => !!w.resetsAt && Date.parse(w.resetsAt) <= now;
  const current = all.filter((w) => !isReset(w));
  const top = current.length
    ? current.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
    : null;
  const stale = shown.some((q) => q.stale);
  const resetText = (w: QuotaWindow) => {
    if (!w.resetsAt) return null;
    const left = formatCountdown(Date.parse(w.resetsAt) - now);
    return left ? t('quota.resetsIn', { t: left }) : t('quota.reset');
  };
  const resetAt = (resetsAt: string) => {
    const { date, clock } = formatResetTime(resetsAt, now, intl);
    return date ? t('quota.resetsOn', { date, clock }) : t('quota.resetsAt', { clock });
  };
  const sourceName = (id: string) => {
    const key = SOURCES[id];
    return key ? t(key) : id;
  };
  const longLabel = (w: QuotaWindow) =>
    w.kind === 'session'
      ? t('quota.windowSession')
      : w.kind === 'weekly'
        ? t('quota.windowWeekly')
        : w.kind === 'weekly-model'
          ? t('quota.windowModel', { model: w.model ?? w.id })
          : w.id;

  return (
    <div className={css.wrap} ref={ref} data-stale={stale || undefined}>
      <button type="button" className={css.bar} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Gauge size={14} aria-hidden="true" className={css.icon} />
        <span className="visually-hidden">{t('quota.title')}</span>
        {all.map((w, i) => (
          // biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot carry the visible "5h 62%" label
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: the same window id can come from two agents
            key={`${w.id}:${i}`}
            role="meter"
            aria-label={shortLabel(w)}
            aria-valuetext={`${shortLabel(w)} ${isReset(w) ? t('quota.reset') : `${pct(w)}%`}`}
            aria-valuenow={isReset(w) ? 0 : pct(w)}
            aria-valuemin={0}
            aria-valuemax={100}
            className={css.meter}
            data-level={isReset(w) ? 'ok' : levelOf(w.usedPercent)}
            data-reset={isReset(w) || undefined}
            data-top={w === top || undefined}
            title={[longLabel(w), t('quota.used', { pct: `${pct(w)}%` }), resetText(w)]
              .filter(Boolean)
              .join(' · ')}
          >
            <span className="num">
              {shortLabel(w)} {isReset(w) ? t('quota.reset') : `${pct(w)}%`}
            </span>
            <span className={css.track} aria-hidden="true">
              <span style={{ width: `${isReset(w) ? 0 : pct(w)}%` }} />
            </span>
          </span>
        ))}
        {stale && (
          <span className={css.staleNote}>
            {t('quota.stale', { age: formatRelative(shown[0]?.fetchedAt, now, intl) })}
          </span>
        )}
      </button>
      {open && (
        <div className={css.popover} role="dialog" aria-label={t('quota.title')}>
          {shown.map((q) => (
            <div key={q.agent} className={css.snapshot}>
              {q.windows.map((w) => (
                <div key={w.id} className={css.row} data-level={levelOf(w.usedPercent)}>
                  <div className={css.rowHead}>
                    <span className={css.rowLabel}>{longLabel(w)}</span>
                    <span className="num">{t('quota.used', { pct: `${pct(w)}%` })}</span>
                  </div>
                  <span className={css.track} aria-hidden="true">
                    <span style={{ width: `${pct(w)}%` }} />
                  </span>
                  {w.resetsAt && (
                    <span className={css.reset}>
                      {resetText(w)} · {resetAt(w.resetsAt)}
                    </span>
                  )}
                </div>
              ))}
              {q.extraUsage && (
                <p className={css.meta}>
                  {t('quota.extra', {
                    used: q.extraUsage.used.toLocaleString(intl),
                    limit: `${q.extraUsage.limit === null ? '—' : q.extraUsage.limit.toLocaleString(intl)}${q.extraUsage.currency ? ` ${q.extraUsage.currency}` : ''}`,
                  })}
                </p>
              )}
              <p className={css.meta}>
                {t(q.stale ? 'quota.stale' : 'quota.updated', {
                  age: formatRelative(q.fetchedAt, now, intl),
                })}
              </p>
              <p className={css.meta}>{t('quota.source', { source: sourceName(q.source) })}</p>
            </div>
          ))}
          <p className={css.note}>{t('quota.note')}</p>
        </div>
      )}
    </div>
  );
}
