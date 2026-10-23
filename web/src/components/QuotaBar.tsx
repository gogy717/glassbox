import { Gauge } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { QuotaSnapshot, QuotaWindow } from '../../../src/core/model.js';
import { type MessageKey, useI18n } from '../i18n';
import { formatCountdown, formatRelative, formatResetTime } from '../lib/format';
import { providerName, providerShortName } from '../lib/provider-names';
import css from './QuotaBar.module.css';

interface Props {
  quotas: QuotaSnapshot[];
  now: number;
}

type Level = 'ok' | 'warn' | 'danger';
const levelOf = (pct: number): Level => (pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok');

const pct = (w: QuotaWindow) => Math.round(Math.min(100, Math.max(0, w.usedPercent)));

/** From this many providers on, the top bar shows only the top one below a wider breakpoint. */
const MANY = 4;

/** Where quota numbers can come from, in words; an id not listed here shows as itself. */
const SOURCES: Record<string, MessageKey> = {
  'claude-code-cache': 'quota.sourceClaudeCodeCache',
  'anthropic-usage-api': 'quota.sourceAnthropicApi',
  'oh-my-pi-cache': 'quota.sourceOmpCache',
  'codex-session': 'quota.sourceCodexSession',
  'deepseek-api': 'quota.sourceDeepseekApi',
  'xai-api': 'quota.sourceXaiApi',
};

/** "¥12.30": the currency's own symbol; a code Intl does not know follows the amount instead. */
export function formatBalance(balance: { amount: number; currency: string }, intl: string): string {
  try {
    return new Intl.NumberFormat(intl, {
      style: 'currency',
      currency: balance.currency,
      currencyDisplay: 'narrowSymbol',
    }).format(balance.amount);
  } catch {
    const amount = balance.amount.toLocaleString(intl, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${amount} ${balance.currency}`;
  }
}

/**
 * Plan quota at a glance (ClaudeBar-style): one meter per provider, at its window closest to the
 * limit, or its balance when it has no windows. Click for every window and where the data came from.
 */
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

  const shown = quotas.filter((q) => q.windows.length > 0 || q.balance);
  if (shown.length === 0) return null;
  // Past its reset time the cached percentage is history: never show it as current usage.
  const isReset = (w: QuotaWindow) => !!w.resetsAt && Date.parse(w.resetsAt) <= now;
  const meters = shown.map((q, i) => ({
    q,
    // The server sends one snapshot per provider, but nothing here relies on it.
    key: `${q.provider}:${q.source}:${i}`,
    top: q.windows
      .filter((w) => !isReset(w))
      .reduce<QuotaWindow | null>((a, b) => (!a || b.usedPercent > a.usedPercent ? b : a), null),
  }));
  // The one meter narrow screens keep: the provider closest to a limit, else the first.
  const lead = meters.reduce((a, b) =>
    b.top && (!a.top || b.top.usedPercent > a.top.usedPercent) ? b : a,
  );
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
  const windowName = (w: QuotaWindow) =>
    w.label ??
    (w.kind === 'session'
      ? t('quota.windowSession')
      : w.kind === 'weekly'
        ? t('quota.windowWeekly')
        : w.kind === 'weekly-model'
          ? t('quota.windowModel', { model: w.model ?? w.id })
          : w.kind === 'monthly'
            ? t('quota.windowMonthly')
            : w.id);
  const heading = (q: QuotaSnapshot) =>
    q.plan ? `${providerName(q.provider)} · ${q.plan}` : providerName(q.provider);
  const age = (q: QuotaSnapshot) =>
    t(q.stale ? 'quota.stale' : 'quota.updated', { age: formatRelative(q.fetchedAt, now, intl) });

  return (
    <div className={css.wrap} ref={ref} data-many={shown.length >= MANY || undefined}>
      <button type="button" className={css.bar} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Gauge size={14} aria-hidden="true" className={css.icon} />
        <span className="visually-hidden">{t('quota.title')}</span>
        {meters.map((m) => {
          const { q, top } = m;
          const name = providerShortName(q.provider);
          const value = top
            ? `${pct(top)}%`
            : q.windows.length > 0 || !q.balance
              ? t('quota.reset')
              : formatBalance(q.balance, intl);
          const title = [
            heading(q),
            top && `${windowName(top)} ${t('quota.used', { pct: `${pct(top)}%` })}`,
            top && resetText(top),
            q.balance && t('quota.balance', { amount: formatBalance(q.balance, intl) }),
            q.stale && age(q),
          ]
            .filter(Boolean)
            .join(' · ');
          const shared = {
            className: css.meter,
            'data-top': m === lead || undefined,
            'data-stale': q.stale || undefined,
            title,
          };
          return q.windows.length > 0 ? (
            // biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot carry the visible "Claude 62%" label
            <span
              key={m.key}
              {...shared}
              role="meter"
              aria-label={name}
              aria-valuetext={`${name} ${value}`}
              aria-valuenow={top ? pct(top) : 0}
              aria-valuemin={0}
              aria-valuemax={100}
              data-level={top ? levelOf(top.usedPercent) : 'ok'}
              data-reset={!top || undefined}
            >
              <span className="num">
                {name} {value}
              </span>
              <span className={css.track} aria-hidden="true">
                <span style={{ width: `${top ? pct(top) : 0}%` }} />
              </span>
            </span>
          ) : (
            <span key={m.key} {...shared} data-balance>
              <span className="num">
                {name} {value}
              </span>
              {/* Keeps the text level with the meters beside it. */}
              <span className={css.track} data-empty aria-hidden="true" />
            </span>
          );
        })}
        {meters.length > 1 && <span className={css.more}>+{meters.length - 1}</span>}
      </button>
      {open && (
        <div className={css.popover} role="dialog" aria-label={t('quota.title')}>
          {meters.map(({ q, key }) => (
            <section
              key={key}
              className={css.snapshot}
              aria-label={heading(q)}
              data-stale={q.stale || undefined}
            >
              <h3 className={css.provider}>{heading(q)}</h3>
              {q.windows.map((w) => (
                <div key={w.id} className={css.row} data-level={levelOf(w.usedPercent)}>
                  <div className={css.rowHead}>
                    <span className={css.rowLabel}>{windowName(w)}</span>
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
              {q.balance && (
                <p className={css.balance}>
                  {t('quota.balance', { amount: formatBalance(q.balance, intl) })}
                </p>
              )}
              {q.extraUsage && (
                <p className={css.meta}>
                  {t('quota.extra', {
                    used: q.extraUsage.used.toLocaleString(intl),
                    limit: `${q.extraUsage.limit === null ? '—' : q.extraUsage.limit.toLocaleString(intl)}${q.extraUsage.currency ? ` ${q.extraUsage.currency}` : ''}`,
                  })}
                </p>
              )}
              <p className={css.meta}>{age(q)}</p>
              <p className={css.meta}>{t('quota.source', { source: sourceName(q.source) })}</p>
            </section>
          ))}
          <p className={css.note}>{t('quota.note')}</p>
        </div>
      )}
    </div>
  );
}
