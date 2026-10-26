import { Gauge } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import type { QuotaSnapshot, QuotaWindow } from '../../../src/core/model.js';
import { type I18n, type MessageKey, useI18n } from '../i18n';
import { agentName } from '../lib/agent-names';
import { formatCountdown, formatRelative, formatResetTime } from '../lib/format';
import { providerName, providerShortName } from '../lib/provider-names';
import { quotaWindowName } from '../lib/quota';
import { type Pace, paceOf, quotaLevel } from '../lib/quota-pace';
import { FigureText } from './FigureText';
import { useOnePopover, usePopoverDismiss } from './popover';
import css from './QuotaBar.module.css';

interface Props {
  quotas: QuotaSnapshot[];
  now: number;
  /** A session is open: the meters fold to the top one earlier, so its title keeps its room. */
  sessionOpen?: boolean;
}

const pct = (w: QuotaWindow) => Math.round(Math.min(100, Math.max(0, w.usedPercent)));

/** "29% of the week gone", by what the window spans. */
const GONE: Record<Pace['span'], MessageKey> = {
  hours5: 'quota.goneHours5',
  week: 'quota.goneWeek',
  month: 'quota.goneMonth',
  window: 'quota.goneWindow',
};

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

/** What glassbox asks each provider with: an app's sign-in, or a key in the environment. */
const CREDENTIALS: Record<string, { app: string } | { env: string }> = {
  anthropic: { app: 'Claude Code' },
  xai: { app: 'Grok CLI' },
  deepseek: { env: 'DEEPSEEK_API_KEY' },
};

/** Why a stale quota is stale and how it will refresh, in a sentence; null when not known. */
export function staleReasonText(q: QuotaSnapshot, t: I18n['t']): string | null {
  if (!q.stale || !q.staleReason) return null;
  const credential = CREDENTIALS[q.provider];
  const app = credential && 'app' in credential ? credential.app : null;
  switch (q.staleReason) {
    case 'not-fetching':
      return t('quota.whyNotFetching');
    case 'sign-in-expired':
      return app
        ? t('quota.whySignInExpired', { name: providerShortName(q.provider), app })
        : t('quota.whyFetchFailed');
    case 'no-credentials':
      if (app) return t('quota.whyNoSignIn', { app });
      return credential && 'env' in credential
        ? t('quota.whyNoKey', { env: credential.env })
        : t('quota.whyFetchFailed');
    case 'fetch-failed':
      return t('quota.whyFetchFailed');
    case 'cache-only':
      return q.agent
        ? t('quota.whyCacheOnly', { agent: agentName(q.agent) })
        : t('quota.whyCannotFetch');
    default:
      return null;
  }
}

/** A stale provider's reason, a line of its own in the details. */
function StaleReason({ q }: { q: QuotaSnapshot }) {
  const { t } = useI18n();
  const text = staleReasonText(q, t);
  return text ? <p className={css.why}>{text}</p> : null;
}

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
export function QuotaBar({ quotas, now, sessionOpen = false }: Props) {
  const { t, intl } = useI18n();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useOnePopover('quota', open, close);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  usePopoverDismiss(ref, open, close, buttonRef);

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
  const paceOfIn = (q: QuotaSnapshot, w: QuotaWindow) => paceOf(w, now, q.stale);
  const gonePct = (p: Pace) => `${Math.round(p.elapsed * 100)}%`;
  // On pace, just reset, or when the limit comes: "at this pace, the limit around Thu 14:00".
  const verdict = (p: Pace) => {
    if (p.verdict === 'early') return t('quota.justReset');
    if (p.verdict === 'on-pace' || p.limitAt === null) return t('quota.onPace');
    const { date, clock } = formatResetTime(new Date(p.limitAt).toISOString(), now, intl);
    return date ? t('quota.limitOn', { date, clock }) : t('quota.limitAt', { clock });
  };
  const paceText = (p: Pace) => `${t(GONE[p.span], { pct: gonePct(p) })} · ${verdict(p)}`;
  const sourceName = (id: string) => {
    const key = SOURCES[id];
    return key ? t(key) : id;
  };
  const windowName = (w: QuotaWindow) => quotaWindowName(w, t);
  const heading = (q: QuotaSnapshot) =>
    q.plan ? `${providerName(q.provider)} · ${q.plan}` : providerName(q.provider);
  const age = (q: QuotaSnapshot) =>
    t(q.stale ? 'quota.stale' : 'quota.updated', { age: formatRelative(q.fetchedAt, now, intl) });
  const reading = (name: string, value: string) => (
    <span className={`${css.reading} figure`}>
      <span className={css.name}>{name}</span> <span className={css.value}>{value}</span>
    </span>
  );
  // How old a stale meter's figure is, a muted line under its track ("6 h ago").
  const ageLine = (q: QuotaSnapshot) =>
    q.stale && <span className={css.age}>{formatRelative(q.fetchedAt, now, intl)}</span>;

  return (
    <div
      className={css.wrap}
      ref={ref}
      data-many={shown.length >= MANY || undefined}
      data-single={shown.length === 1 || undefined}
      data-session={sessionOpen || undefined}
    >
      <button
        ref={buttonRef}
        type="button"
        className={css.bar}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
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
          const pace = top && paceOfIn(q, top);
          const title = [
            heading(q),
            top && `${windowName(top)} ${t('quota.used', { pct: `${pct(top)}%` })}`,
            top && resetText(top),
            pace && paceText(pace),
            q.balance && t('quota.balance', { amount: formatBalance(q.balance, intl) }),
            q.stale && age(q),
            staleReasonText(q, t),
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
              aria-valuetext={`${name} ${value}${pace ? ` · ${paceText(pace)}` : ''}`}
              aria-valuenow={top ? pct(top) : 0}
              aria-valuemin={0}
              aria-valuemax={100}
              data-level={top ? quotaLevel(top, pace ?? null) : 'ok'}
              data-reset={!top || undefined}
            >
              {reading(name, value)}
              <span className={css.track} aria-hidden="true">
                <span style={{ width: `${top ? pct(top) : 0}%` }} />
              </span>
              {ageLine(q)}
            </span>
          ) : (
            <span key={m.key} {...shared} data-balance>
              {reading(name, value)}
              {/* Keeps the text level with the meters beside it. */}
              <span className={css.track} data-empty aria-hidden="true" />
              {ageLine(q)}
            </span>
          );
        })}
        {meters.length > 1 && <span className={`${css.more} figure`}>+{meters.length - 1}</span>}
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
              {q.windows.map((w) => {
                const pace = paceOfIn(q, w);
                return (
                  <div key={w.id} className={css.row} data-level={quotaLevel(w, pace)}>
                    <div className={css.rowHead}>
                      <span className={css.rowLabel}>{windowName(w)}</span>
                      <span>
                        <FigureText k="quota.used" params={{ pct: `${pct(w)}%` }} />
                      </span>
                    </div>
                    <span className={css.track} aria-hidden="true">
                      <span style={{ width: `${pct(w)}%` }} />
                    </span>
                    {w.resetsAt && (
                      <span className={css.reset}>
                        {resetText(w)} · {resetAt(w.resetsAt)}
                      </span>
                    )}
                    {/* "57% of the week gone · on pace": the used share above, against the clock. */}
                    {pace && (
                      <span className={css.pace} data-verdict={pace.verdict}>
                        <FigureText k={GONE[pace.span]} params={{ pct: gonePct(pace) }} /> ·{' '}
                        {verdict(pace)}
                      </span>
                    )}
                  </div>
                );
              })}
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
              <StaleReason q={q} />
              <p className={css.meta}>{t('quota.source', { source: sourceName(q.source) })}</p>
            </section>
          ))}
          <p className={css.note}>{t('quota.note')}</p>
        </div>
      )}
    </div>
  );
}
