/**
 * The Stats page's cards (D4): the hour, by CLI, top projects, longest sessions, tokens and right
 * now. The receipt's words where the slip has them (`rt`), so the two read alike; the app's for
 * the rest. A session is a link only while the session list has it (R32).
 */
import type { QuotaSnapshot, QuotaWindow } from '../../../../src/core/model.js';
import { firstCountedIndex, ratePerMinute, rateSeries } from '../../../../src/shared/rate.js';
import type { WeekWindowKind } from '../../../../src/shared/week.js';
import { AgentTag } from '../../components/AgentTag';
import { UiCjk } from '../../components/CompactFigure';
import { Sparkline } from '../../components/RateCharts';
import { count, partsText } from '../../components/receipt/format';
import { rt } from '../../components/receipt/strings';
import { unreportedLine } from '../../components/receipt/week';
import { cliParts, shareText } from '../../components/receipt/weekSvg';
import { useRate } from '../../data/store';
import { type Locale, useI18n } from '../../i18n';
import { agentName } from '../../lib/agent-names';
import { formatCompact, formatPercent, formatResetTime } from '../../lib/format';
import { providerShortName } from '../../lib/provider-names';
import { quotaWindowName } from '../../lib/quota';
import { sessionLink } from '../../router';
import css from './StatsPage.module.css';
import {
  hourOfCell,
  hourSpan,
  type Isolate,
  longestSessions,
  type SessionLine,
  type StatsWeek,
  timeText,
  topProjects,
} from './statsData';
import type { Cell } from './WeekGrid';

/** A card's head: its name, in capitals, and what its figures are, muted. */
function Head({ id, name, note }: { id: string; name: string; note?: string }) {
  return (
    <h2 id={id} className={css.cardHead}>
      <span className="section-label">{name}</span>
      {note && <span className={css.note}>{note}</span>}
    </h2>
  );
}

/** Sessions as rows: the title (a link while listed), its project and CLI, and its time. */
function SessionRows({
  rows,
  listed,
  locale,
}: {
  rows: SessionLine[];
  listed: Set<string>;
  locale: Locale;
}) {
  const { t } = useI18n();
  return (
    <ul className={css.sessions}>
      {rows.map((s) => {
        const title = s.title ?? t('sidebar.untitled');
        return (
          <li key={s.id} className={css.session}>
            <span className={css.sessionMain}>
              {listed.has(s.id) ? (
                <a href={sessionLink(s.id)} className={css.sessionTitle}>
                  {title}
                </a>
              ) : (
                <span className={css.sessionTitle}>{title}</span>
              )}
              <span className={css.sessionMeta}>
                {s.project && <span>{s.project} ·</span>}
                <AgentTag kind={s.agent} />
              </span>
            </span>
            <span className={`${css.sessionTime} figure`}>
              <UiCjk text={timeText(s.ms, locale)} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The hour selected in the grid: when, its agent time, its sessions most minutes first. With no
 * session in the window, says so, and points to the other window when that has some.
 */
export function HourCard(p: {
  w: StatsWeek;
  kind: WeekWindowKind;
  cell: Cell | null;
  listed: Set<string>;
  locale: Locale;
  /** The last 7 days' sessions, when this week has none: the way out. */
  elsewhere: number | null;
  onElsewhere(): void;
}) {
  const { t } = useI18n();
  const L = p.locale;
  const gridCell = p.cell && p.w.receipt.grid[p.cell.row]?.[p.cell.col];
  const hour = gridCell ? hourOfCell(p.w, gridCell) : null;
  if (p.w.receipt.sessions === 0)
    return (
      <section className={css.card} data-area="hour" aria-labelledby="stats-hour">
        <h2 id="stats-hour" className={css.hourTitle}>
          {rt(L, p.kind === 'week' ? 'noSessions' : 'noSessions7')}
        </h2>
        {p.elsewhere !== null && p.elsewhere > 0 && (
          <button type="button" className={css.link} onClick={p.onElsewhere}>
            {t('stats.wayOut', { n: p.elsewhere })}
          </button>
        )}
      </section>
    );
  return (
    <section className={css.card} data-area="hour" aria-labelledby="stats-hour">
      {hour?.start != null ? (
        <>
          <h2 id="stats-hour" className={css.hourTitle}>
            {hourSpan(hour.start, p.kind, L)}
          </h2>
          <p className={css.hourLine}>
            {hour.topCli
              ? t('stats.hourLine', {
                  time: timeText(hour.ms, L),
                  n: hour.sessions.length,
                  cli: agentName(hour.topCli.agent),
                  cliTime: timeText(hour.topCli.ms, L),
                })
              : t('stats.hourIdle')}
          </p>
          <SessionRows rows={hour.sessions} listed={p.listed} locale={L} />
        </>
      ) : (
        <h2 id="stats-hour" className={css.hourTitle}>
          {t('stats.noTime')}
        </h2>
      )}
      <p className={css.hint}>{t('stats.hourHint')}</p>
    </section>
  );
}

/** A row that isolates its CLI or project in the grid: hovered for a look, clicked to pin. */
interface IsolateProps {
  pinned: Isolate | null;
  onHover(by: Isolate | null): void;
  onPin(by: Isolate): void;
}

const isPinned = (pinned: Isolate | null, by: Isolate) =>
  !!pinned &&
  ('cli' in by
    ? 'cli' in pinned && pinned.cli === by.cli
    : 'project' in pinned && pinned.project === by.project);

function BarRow({
  by,
  name,
  value,
  aside,
  share,
  iso,
}: {
  by: Isolate;
  name: string;
  value: string;
  aside?: string;
  share: number;
  iso: IsolateProps;
}) {
  const pinned = isPinned(iso.pinned, by);
  return (
    <li>
      <button
        type="button"
        className={css.barRow}
        aria-pressed={pinned}
        onPointerEnter={() => iso.onHover(by)}
        onPointerLeave={() => iso.onHover(null)}
        onClick={() => iso.onPin(by)}
      >
        <span className={css.barName}>{name}</span>
        <span className={css.barValue}>
          <span className="figure">
            <UiCjk text={value} />
          </span>
          {aside && <span className={`${css.aside} figure`}>{aside}</span>}
        </span>
        <span className={css.track} aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(100, share))}%` }} />
        </span>
      </button>
    </li>
  );
}

/** By CLI: each CLI's agent time and share, as the receipt prints them (DR4, DR8, DR10). */
export function CliCard({ w, locale, iso }: { w: StatsWeek; locale: Locale; iso: IsolateProps }) {
  const { t } = useI18n();
  const r = w.receipt;
  return (
    <section className={css.card} data-area="cli" aria-labelledby="stats-cli">
      <Head id="stats-cli" name={rt(locale, 'byCli')} note={t('stats.agentTime')} />
      <ul className={css.bars}>
        {r.byCli.map((c) => (
          <BarRow
            key={c.agent}
            by={{ cli: c.agent }}
            name={agentName(c.agent)}
            value={partsText(cliParts(c, r.cliUnit, locale))}
            aside={c.share === null ? undefined : shareText(c.share)}
            share={c.share === null ? 0 : c.share === '<1' ? 1 : c.share}
            iso={iso}
          />
        ))}
      </ul>
      <p className={css.hint}>{t('stats.cliHint')}</p>
    </section>
  );
}

/** Top projects: agent time and sessions, the bar its share of the week's agent time. */
export function ProjectsCard({
  w,
  locale,
  iso,
}: {
  w: StatsWeek;
  locale: Locale;
  iso: IsolateProps;
}) {
  const { t } = useI18n();
  const all = w.receipt.agentMs;
  return (
    <section className={css.card} data-area="projects" aria-labelledby="stats-projects">
      <Head id="stats-projects" name={t('stats.projects')} note={t('stats.projectsNote')} />
      <ul className={css.bars}>
        {topProjects(w).map((p) => (
          <BarRow
            key={p.name}
            by={{ project: p.name }}
            name={p.name}
            value={timeText(p.ms, locale)}
            aside={count(p.sessions, locale)}
            share={all > 0 ? (p.ms / all) * 100 : 0}
            iso={iso}
          />
        ))}
      </ul>
    </section>
  );
}

/** Longest sessions: five, by their own clock (session time, as the slip's LONGEST). */
export function LongestCard({
  w,
  listed,
  locale,
}: {
  w: StatsWeek;
  listed: Set<string>;
  locale: Locale;
}) {
  const { t } = useI18n();
  return (
    <section className={css.card} data-area="longest" aria-labelledby="stats-longest">
      <Head id="stats-longest" name={t('stats.longest')} note={t('stats.longestNote')} />
      <SessionRows rows={longestSessions(w)} listed={listed} locale={locale} />
    </section>
  );
}

const KINDS = ['cacheRead', 'cacheWrite', 'uncached', 'output'] as const;
const KIND_COLOUR = {
  cacheRead: 'var(--tok-cache-read)',
  cacheWrite: 'var(--tok-cache-write)',
  uncached: 'var(--tok-input)',
  output: 'var(--tok-output)',
};

/** Tokens: the four kinds as a tape and as figures, as the receipt counts them. */
export function TokensCard({ w, locale }: { w: StatsWeek; locale: Locale }) {
  const { t, intl } = useI18n();
  const tk = w.receipt.tokens;
  const fmt = (n: number) => formatCompact(n, intl);
  const sum = tk.cacheRead + tk.cacheWrite + tk.uncached + tk.output;
  const note = unreportedLine(w.receipt, locale, () => true);
  return (
    <section className={css.card} data-area="tokens" aria-labelledby="stats-tokens">
      <Head id="stats-tokens" name={rt(locale, 'tokens')} note={t('stats.tokensNote')} />
      {w.receipt.sessions === 0 ? (
        <p className={css.hint}>—</p>
      ) : tk.measured ? (
        <>
          <div className={css.tape} aria-hidden="true">
            {KINDS.map((k) =>
              tk[k] > 0 ? (
                <span key={k} style={{ flexGrow: tk[k] / sum, background: KIND_COLOUR[k] }} />
              ) : null,
            )}
          </div>
          <div className={css.figures}>
            {KINDS.map((k) => (
              <div key={k} className={css.figure}>
                <span className={`${css.value} figure`}>
                  <UiCjk text={fmt(tk[k])} />
                  {k === 'output' && tk.thinking > 0 && (
                    <span className={css.aside}>
                      {' '}
                      <UiCjk text={t('stats.thinking', { n: fmt(tk.thinking) })} />
                    </span>
                  )}
                </span>
                <span className="section-label">{rt(locale, k)}</span>
              </div>
            ))}
            <div className={css.figure}>
              <span className={`${css.value} figure`}>
                {tk.cacheHit === null ? '—' : formatPercent(tk.cacheHit, intl)}
              </span>
              <span className="section-label">{rt(locale, 'cacheHit')}</span>
            </div>
            <div className={css.figure} data-total>
              <span className={`${css.value} figure`}>
                <UiCjk text={fmt(tk.total)} />
              </span>
              <span className="section-label">{rt(locale, 'total')}</span>
            </div>
          </div>
          {note && <p className={css.hint}>{note}</p>}
        </>
      ) : (
        <p className={css.hint}>{rt(locale, 'notReported')}</p>
      )}
    </section>
  );
}

/** Amber from 80%, red from 95%, as the top bar's meters. */
const levelOf = (pct: number) => (pct >= 95 ? 'danger' : pct >= 80 ? 'warn' : 'ok');

/**
 * Right now: the machine's token rate as it moves, and each plan's use, a row a provider as the
 * top bar's meters: the window closest to its limit (one past its reset is history, not use).
 */
export function NowCard({ quotas, now }: { quotas: QuotaSnapshot[]; now: number }) {
  const { t, intl } = useI18n();
  const rate = useRate();
  const avg = rate ? ratePerMinute(rate, { agent: null }) : 0;
  const resets = (iso: string) => {
    const { date, clock } = formatResetTime(iso, now, intl);
    const weekday = new Intl.DateTimeFormat(intl, { weekday: 'short' }).format(Date.parse(iso));
    return t('stats.resets', { time: date === null ? clock : weekday });
  };
  const rows = quotas.flatMap((q) => {
    const top = q.windows
      .filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > now)
      .reduce<QuotaWindow | null>((a, b) => (!a || b.usedPercent > a.usedPercent ? b : a), null);
    if (!top) return [];
    return [
      {
        key: `${q.provider}:${q.source}`,
        name: providerShortName(q.provider),
        window: quotaWindowName(top, t),
        pct: Math.round(Math.min(100, Math.max(0, top.usedPercent))),
        stale: q.stale,
        reset: top.resetsAt ? resets(top.resetsAt) : t('stats.noReset'),
      },
    ];
  });
  return (
    <section className={css.card} data-area="now" aria-labelledby="stats-now">
      <h2 id="stats-now" className={css.cardHead}>
        <span className="section-label">{t('stats.now')}</span>
        <span className={css.live}>{t('stats.live')}</span>
      </h2>
      <div className={css.rate}>
        <span className={`${css.rateFigure} figure`}>
          <UiCjk text={avg > 0 ? formatCompact(avg, intl) : '—'} />
        </span>
        <span className={css.note}>{t('stats.perMin')}</span>
        {rate && (
          <Sparkline
            className={css.spark}
            values={rateSeries(rate, { agent: null })}
            from={firstCountedIndex(rate)}
            width={160}
            height={28}
          />
        )}
      </div>
      {rows.length > 0 ? (
        <ul className={css.quota}>
          {rows.map((r) => (
            <li
              key={r.key}
              className={css.quotaRow}
              data-level={levelOf(r.pct)}
              data-stale={r.stale || undefined}
              title={r.window}
            >
              <span className={css.quotaName}>{r.name}</span>
              <span className={css.track} aria-hidden="true">
                <span style={{ width: `${r.pct}%` }} />
              </span>
              <span className={`${css.quotaPct} figure`}>{r.pct}%</span>
              <span className={css.quotaReset}>{r.reset}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={css.hint}>{t('stats.noQuota')}</p>
      )}
    </section>
  );
}
