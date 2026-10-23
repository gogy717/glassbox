import { Stethoscope } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Diagnostics as Diag } from '../../../src/core/model.js';
import { useSessionAgent } from '../data/session-agent';
import { type MessageKey, useI18n } from '../i18n';
import css from './Diagnostics.module.css';

/** `Diagnostics.unavailable` keys we can explain; any other key is shown as is. */
const GAPS: Record<string, MessageKey> = {
  'request-detail': 'diag.u.requestDetail',
  'in-flight': 'diag.u.inFlight',
  'per-request-usage': 'diag.u.perRequestUsage',
  'live-state-heuristic': 'diag.u.liveStateHeuristic',
  'live-state-unfinished-reply': 'diag.u.liveStateUnfinishedReply',
  'compaction-markers': 'diag.u.compactionMarkers',
  subagents: 'diag.u.subagents',
  'archived-sessions': 'diag.u.archivedSessions',
  'live-state': 'diag.u.liveState',
  'other-branches': 'diag.u.otherBranches',
  'broken-tree': 'diag.u.brokenTree',
};

/** Requests the adapter dropped on purpose (Claude Code re-sent them); informational only. */
const SUPERSEDED = 'superseded-request';

/** What this session's data cannot show, and what the adapter could not read. */
export function Diagnostics({ diagnostics: d }: { diagnostics: Diag }) {
  const { t, intl } = useI18n();
  const agent = useSessionAgent();
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

  const unknown = Object.entries(d.unknownRecordTypes).filter(([k]) => k !== SUPERSEDED);
  const superseded = d.unknownRecordTypes[SUPERSEDED] ?? 0;
  // Each gap listed in the panel: missing data, unparsable lines, unrecognised record types.
  const gaps = d.unavailable.length + (d.parseErrors > 0 ? 1 : 0) + unknown.length;
  const alert = gaps > 0;
  const count = alert ? t('diag.count', { n: gaps }) : null;
  const n = (v: number) => v.toLocaleString(intl);

  return (
    <div className={css.wrap} ref={ref}>
      <button
        type="button"
        className={css.button}
        aria-label={count ? `${t('diag.title')} · ${count}` : t('diag.title')}
        title={t('diag.title')}
        aria-expanded={open}
        data-alert={alert || undefined}
        onClick={() => setOpen(!open)}
      >
        <Stethoscope size={14} aria-hidden="true" />
        {count && <span className={css.count}>{count}</span>}
      </button>
      {open && (
        <div className={css.panel} role="dialog" aria-label={t('diag.title')}>
          <strong>{t('diag.title')}</strong>
          {!alert && <p className={css.ok}>{t('diag.ok')}</p>}
          {d.unavailable.length > 0 && (
            <>
              <h4>{t('diag.unavailableHead')}</h4>
              <ul>
                {d.unavailable.map((k) => (
                  <li key={k}>
                    {GAPS[k] ? t(GAPS[k] as MessageKey, { agent }) : <code>{k}</code>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {d.parseErrors > 0 && <p>{t('diag.parseErrors', { n: n(d.parseErrors) })}</p>}
          {superseded > 0 && (
            <p className={css.muted}>{t('diag.superseded', { n: n(superseded) })}</p>
          )}
          {unknown.length > 0 && (
            <>
              <h4>{t('diag.unknownHead')}</h4>
              <table className={css.table}>
                <tbody>
                  {unknown.map(([k, v]) => (
                    <tr key={k}>
                      <td>
                        <code>{k}</code>
                      </td>
                      <td className="num">{n(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
