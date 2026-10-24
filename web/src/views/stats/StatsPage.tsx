import { useEffect, useMemo, useState } from 'react';
import type { QuotaSnapshot, SessionSummary } from '../../../../src/core/model.js';
import { type WeekWindowKind, weekWindow } from '../../../../src/shared/week.js';
import { UiCjk } from '../../components/CompactFigure';
import { WAIT_MS } from '../../components/Delayed';
import { clock, count, hourOf } from '../../components/receipt/format';
import { rt } from '../../components/receipt/strings';
import { listedOnly } from '../../components/receipt/week';
import { Switch } from '../../components/Switch';
import { WeeklyReceiptButton } from '../../components/WeeklyReceiptButton';
import { useWeekCache, useWeeksOf } from '../../data/store';
import type { WeekEntry } from '../../data/weeks';
import { type Locale, useI18n } from '../../i18n';
import { agentName } from '../../lib/agent-names';
import { CliCard, HourCard, LongestCard, NowCard, ProjectsCard, TokensCard } from './StatsCards';
import css from './StatsPage.module.css';
import {
  busiestCell,
  hourOfCell,
  hourSpan,
  type Isolate,
  isolated,
  type StatsWeek,
  spanLine,
  statsWeek,
  timeText,
  topProjects,
} from './statsData';
import { useStatsWeek } from './useStatsWeek';
import { type Cell, WeekGrid } from './WeekGrid';

export interface StatsPageProps {
  /** The window in the route: this week, or the last 7 days. */
  window: WeekWindowKind;
  /** Another window picked: the route changes in place, so Back leaves the page. */
  onWindow(window: WeekWindowKind): void;
  /** Probe sessions count only when the sidebar shows them, as on the receipt. */
  showProbes: boolean;
  /** The session list: a session links only while it is on it (R32). */
  sessions: SessionSummary[];
  quotas: QuotaSnapshot[];
  now: number;
}

/** True once `on` has held for `ms`: a read that ends sooner never says it was reading. */
function useHeld(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on) {
      setHeld(false);
      return;
    }
    const id = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(id);
  }, [on, ms]);
  return on && held;
}

/**
 * The Stats page (D4): this machine's week, the weekly receipt's interactive sibling, from the
 * same results (R30) and the same counts (N6). Its head: the window, its span and sessions, when
 * the data is from, and Print. Then the overview, when the agents worked beside the hour, by CLI,
 * top projects and longest sessions, tokens beside right now. What was read before shows at once
 * while the window is read again; a first read shows its progress over empty cards.
 */
export function StatsPage({
  window: kind,
  onWindow,
  showProbes,
  sessions,
  quotas,
  now,
}: StatsPageProps) {
  const { t, locale } = useI18n();
  const entry = useStatsWeek(kind);
  const cache = useWeekCache();
  const w = useMemo(
    () => (entry.result ? statsWeek(entry.result, showProbes) : null),
    [entry.result, showProbes],
  );
  const listed = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);
  const updating = useHeld(!!entry.result && !!entry.reading, WAIT_MS);
  const refresh = () => cache.request(kind, { refresh: true });
  return (
    <div className={css.stats}>
      <h1 className="visually-hidden">{t('nav.stats')}</h1>
      <div className={css.head}>
        <Switch
          variant="segmented"
          label={t('stats.window')}
          value={kind}
          onChange={onWindow}
          options={[
            { value: 'week', label: t('stats.thisWeek') },
            { value: '7d', label: t('stats.last7') },
          ]}
        />
        <span className={css.range}>
          {w
            ? t('stats.range', {
                span: spanLine(kind, w.receipt.start, w.receipt.now, locale),
                n: count(w.receipt.sessions, locale),
                p: count(w.receipt.projects, locale),
              })
            : spanLine(kind, weekWindow(kind, now).hourStarts[0] ?? now, now, locale)}
        </span>
        <span className={css.status}>
          <Status entry={entry} updating={updating} locale={locale} onRefresh={refresh} />
        </span>
        <WeeklyReceiptButton showProbes={showProbes} start={kind} />
      </div>
      {!entry.result && entry.reading && (
        <div className={css.progress} aria-hidden="true">
          <span
            style={{
              width: `${entry.reading.total > 0 ? (entry.reading.done / entry.reading.total) * 100 : 0}%`,
            }}
          />
        </div>
      )}
      {w ? (
        <Week
          // A window of its own: its hour back on its busiest, nothing pinned.
          key={kind}
          w={w}
          kind={kind}
          listed={listed}
          quotas={quotas}
          now={now}
          showProbes={showProbes}
          onWindow={onWindow}
        />
      ) : (
        <Skeleton />
      )}
    </div>
  );
}

/** When the data is from, and Refresh; or how far a first read got; or why it failed. */
function Status({
  entry,
  updating,
  locale,
  onRefresh,
}: {
  entry: WeekEntry;
  updating: boolean;
  locale: Locale;
  onRefresh(): void;
}) {
  const again = (
    <button type="button" className={css.link} onClick={onRefresh}>
      {rt(locale, 'refresh')}
    </button>
  );
  if (entry.failed !== null)
    return (
      <span role="alert" className={css.failed}>
        {rt(locale, 'weekFailed', { msg: entry.failed })} · {again}
      </span>
    );
  if (!entry.result)
    return (
      <span role="status">
        {entry.reading
          ? rt(locale, 'reading', { done: entry.reading.done, total: entry.reading.total })
          : ''}
      </span>
    );
  return (
    <span role="status">
      {rt(locale, 'asOf', { time: clock(entry.result.asOf) })} ·{' '}
      {updating ? rt(locale, 'updating') : again}
    </span>
  );
}

/** The cards, empty, while the window is read the first time. */
function Skeleton() {
  return (
    <div className={css.cards} aria-hidden="true" data-skeleton>
      <div className={css.overview} />
      <div className={css.card} data-area="grid" />
      <div className={css.card} data-area="hour" />
      <div className={css.card} />
      <div className={css.card} />
      <div className={css.card} />
      <div className={css.card} data-area="tokens" />
      <div className={css.card} data-area="now" />
    </div>
  );
}

/** A figure of the overview: in the mono face above its label, as the Summary bar's. */
function Figure({
  value,
  label,
  aside,
  alarm,
}: {
  value: string;
  label: string;
  aside?: string;
  alarm?: boolean;
}) {
  return (
    <div className={css.metric} data-alarm={alarm || undefined}>
      <span className={`${css.metricValue} figure`}>
        <UiCjk text={value} />
        {aside && (
          <span className={css.aside}>
            {' '}
            <UiCjk text={aside} />
          </span>
        )}
      </span>
      <span className="section-label">{label}</span>
    </div>
  );
}

function Week({
  w,
  kind,
  listed,
  quotas,
  now,
  showProbes,
  onWindow,
}: {
  w: StatsWeek;
  kind: WeekWindowKind;
  listed: Set<string>;
  quotas: QuotaSnapshot[];
  now: number;
  showProbes: boolean;
  onWindow(window: WeekWindowKind): void;
}) {
  const { t, locale } = useI18n();
  const L = locale;
  const r = w.receipt;
  const [picked, setPicked] = useState<Cell | null>(null);
  const selected = picked ?? busiestCell(w);
  const [pinned, setPinned] = useState<Isolate | null>(null);
  const [hovered, setHovered] = useState<Isolate | null>(null);
  const by = hovered ?? pinned;
  const shown = useMemo(() => (by ? isolated(w, by) : w), [w, by]);
  const drawn = shown.receipt;
  const elsewhere = useElsewhere(kind === 'week' && r.sessions === 0, showProbes);
  const who = (i: Isolate) => ('cli' in i ? agentName(i.cli) : i.project);
  const iso = {
    pinned,
    onHover: setHovered,
    onPin: (i: Isolate) => setPinned((p) => (p && who(p) === who(i) ? null : i)),
  };
  // A cell's hour and what was done in it, as drawn: one CLI's or project's alone when isolated.
  const describe = (at: Cell) => {
    const cell = drawn.grid[at.row]?.[at.col];
    const hour = cell ? hourOfCell(shown, cell) : null;
    const title = hour?.start != null ? hourSpan(hour.start, kind, L) : '—';
    if (!cell || cell.state === 'out') return { title, line: '—' };
    if (cell.state === 'future') return { title, line: t('stats.cellAhead') };
    if (!hour?.topCli) return { title, line: t('stats.cellIdle') };
    return {
      title,
      line: t('stats.cell', {
        time: timeText(hour.ms, L),
        n: hour.sessions.length,
        cli: agentName(hour.topCli.agent),
        cliTime: timeText(hour.topCli.ms, L),
      }),
    };
  };
  const caption = by
    ? t(pinned && !hovered ? 'stats.only' : 'stats.onlyHover', {
        who: who(by),
        time: timeText(drawn.agentMs, L),
      })
    : t('stats.isolateHint');
  return (
    // Escape unpins whatever was pinned, from anywhere on the page.
    // biome-ignore lint/a11y/noStaticElementInteractions: a key handler for the page's own Escape
    <div
      className={css.cards}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && pinned) setPinned(null);
      }}
    >
      <section className={css.overview} aria-label={t('summary.title')}>
        <Figure value={timeText(r.agentMs, L)} label={rt(L, 'agentTime')} />
        <Figure value={timeText(r.sessionMs, L)} label={rt(L, 'sessionTime')} />
        <Figure
          value={count(r.sessions, L)}
          aside={`· ${rt(L, 'projectsN', { n: r.projects })}`}
          label={rt(L, 'sessions', { n: r.sessions })}
        />
        <Figure
          value={count(r.work.requests, L)}
          label={rt(L, 'modelCalls', { n: r.work.requests })}
        />
        <Figure
          value={count(r.work.toolCalls, L)}
          label={rt(L, 'toolCalls', { n: r.work.toolCalls })}
        />
        <Figure
          value={count(r.work.subAgents, L)}
          label={rt(L, 'subAgents', { n: r.work.subAgents })}
        />
        <Figure
          value={count(r.work.failures, L)}
          label={rt(L, 'failures', { n: r.work.failures })}
          alarm={r.work.failures > 0}
        />
      </section>
      <section className={css.card} data-area="grid" aria-labelledby="stats-when">
        <div className={css.cardTop}>
          <h2 id="stats-when" className={`${css.cardHead} section-label`}>
            {t('stats.when')}
          </h2>
          <Legend />
        </div>
        <WeekGrid
          drawn={drawn}
          locale={L}
          label={t('stats.when')}
          selected={selected}
          onSelect={setPicked}
          describe={describe}
        />
        <div className={css.gridFoot}>
          <span>
            {rt(L, 'busiestHour')}{' '}
            <strong>
              {r.busiest ? `${hourOf(r.busiest.at, L)} · ${timeText(r.busiest.ms, L)}` : '—'}
            </strong>
          </span>
          <span>
            {rt(L, 'afterHours')} {/* Whole percents, as the slip prints it. */}
            <strong>{r.afterHours === null ? '—' : `${Math.round(r.afterHours * 100)}%`}</strong>
          </span>
          <span className={css.caption}>{caption}</span>
        </div>
      </section>
      <HourCard
        w={w}
        kind={kind}
        cell={selected}
        listed={listed}
        locale={L}
        elsewhere={elsewhere}
        onElsewhere={() => onWindow('7d')}
      />
      <CliCard w={w} locale={L} iso={iso} />
      {topProjects(w).length > 0 && <ProjectsCard w={w} locale={L} iso={iso} />}
      <LongestCard w={w} listed={listed} locale={L} />
      <TokensCard w={w} locale={L} />
      <NowCard quotas={quotas} now={now} />
    </div>
  );
}

/** The grid's inks, as a key: an hour with none, under 10 minutes, under 40, and 40 or more. */
function Legend() {
  const { t } = useI18n();
  return (
    <span className={`${css.legend} figure`} aria-hidden="true">
      <span data-ink="none" />0<span data-ink="low" />
      {'<10'}
      <span data-ink="mid" />
      {'<40'}
      <span data-ink="high" />
      <UiCjk text={`40+ ${t('stats.minutes')}`} />
    </span>
  );
}

/** The last 7 days' sessions, read when this week has none: the hour card's way out. */
function useElsewhere(wanted: boolean, showProbes: boolean): number | null {
  const cache = useWeekCache();
  const weeks = useWeeksOf(cache);
  useEffect(() => {
    if (!wanted) return;
    const release = cache.retain('7d');
    cache.request('7d');
    return release;
  }, [cache, wanted]);
  const other = weeks['7d']?.result;
  return wanted && other ? listedOnly(other, showProbes).sessions.length : null;
}
