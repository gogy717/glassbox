/**
 * "Who used it", in the quota's details: the sessions that used a plan window most, each with its
 * share as a bar and its tokens, then "and N more", and a footnote saying the shares are of what
 * glassbox saw on this machine (never a split of the provider's figure). A row opens its session
 * while the session list has it.
 */

import { topBurn } from '../../../src/shared/quota-burn.js';
import type { BurnState } from '../data/quotaBurn';
import { useI18n } from '../i18n';
import { agentName } from '../lib/agent-names';
import { formatCompact, formatResetTime } from '../lib/format';
import { sessionLink } from '../router';
import css from './QuotaBurn.module.css';

/** Rows listed before "and N more". */
export const BURN_ROWS = 5;

/** A share as a whole percentage; "<1%" for one too small to round up to 1. */
export function sharePct(share: number): string {
  if (share > 0 && share < 0.005) return '<1%';
  return `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`;
}

export function QuotaBurnList({
  state,
  now,
  listed,
  onOpen,
}: {
  state: BurnState;
  now: number;
  /** Sessions a row may link to; null: every row links. */
  listed: ReadonlySet<string> | null;
  /** A row's link was followed. */
  onOpen?: () => void;
}) {
  const { t, intl } = useI18n();
  if (state.status === 'off') return null;
  const head = (since?: number) => {
    let when: string | null = null;
    if (since !== undefined) {
      const { date, clock } = formatResetTime(new Date(since).toISOString(), now, intl);
      when = t('quota.burnSince', { clock: date ? `${date} ${clock}` : clock });
    }
    return (
      <div className={css.head}>
        <span className={css.title}>{t('quota.burnTitle')}</span>
        {when && <span className={css.since}>{when}</span>}
      </div>
    );
  };
  if (state.status !== 'ok')
    return (
      <div className={css.burn}>
        {head()}
        <p className={css.note}>
          {t(state.status === 'reading' ? 'quota.burnReading' : 'quota.burnFailed')}
        </p>
      </div>
    );
  const { burn } = state;
  const byRequests = burn.counted === 'requests';
  const { top, more } = topBurn(burn.sessions, BURN_ROWS);
  return (
    <div className={css.burn}>
      {head(burn.since)}
      {top.length === 0 ? (
        <p className={css.note}>{t('quota.burnNone')}</p>
      ) : (
        <>
          <ol className={css.rows} aria-label={t('quota.burnTitle')}>
            {top.map((s) => {
              const title = s.title ?? t('sidebar.untitled');
              const share = sharePct(s.share);
              const text = byRequests
                ? t('quota.burnRowRequests', { title, share, n: s.requests })
                : t('quota.burnRow', {
                    title,
                    share,
                    tokens: formatCompact(s.tokens, intl),
                    n: s.requests,
                  });
              const name = (
                <>
                  {title}
                  <span className="visually-hidden"> · {agentName(s.agent)}</span>
                </>
              );
              return (
                <li key={s.id} className={css.row} title={`${text} · ${agentName(s.agent)}`}>
                  {listed === null || listed.has(s.id) ? (
                    <a href={sessionLink(s.id)} className={css.name} onClick={onOpen}>
                      {name}
                    </a>
                  ) : (
                    <span className={css.name}>{name}</span>
                  )}
                  <span className={css.track} aria-hidden="true">
                    <span style={{ width: `${Math.round(s.share * 100)}%` }} />
                  </span>
                  <span className={`${css.share} figure`}>{share}</span>
                  <span className={`${css.amount} figure`}>
                    {byRequests ? s.requests.toLocaleString(intl) : formatCompact(s.tokens, intl)}
                  </span>
                </li>
              );
            })}
          </ol>
          {more.count > 0 && (
            <p className={css.more}>
              {t('quota.burnMore', { n: more.count, share: sharePct(more.share) })}
            </p>
          )}
          <p className={css.foot}>{t(byRequests ? 'quota.burnNoteRequests' : 'quota.burnNote')}</p>
        </>
      )}
    </div>
  );
}
