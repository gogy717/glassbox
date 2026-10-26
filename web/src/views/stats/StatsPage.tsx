import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { QuotaSnapshot, SessionSummary } from '../../../../src/core/model.js';
import { type WeekWindowKind, weekWindow } from '../../../../src/shared/week.js';
import { UiCjk } from '../../components/CompactFigure';
import { WAIT_MS } from '../../components/Delayed';
import { clock, count, hourOf } from '../../components/receipt/format';
import { rt } from '../../components/receipt/strings';
import { listedOnly } from '../../components/receipt/week';
import { Switch } from '../../components/Switch';
import { WeeklyReceiptButton } from '../../components/WeeklyReceiptButton';
import { useWeekCache } from '../../data/store';
import type { WeekEntry } from '../../data/weeks';
import { type Locale, useI18n } from '../../i18n';
import { agentName } from '../../lib/agent-names';
import {
  CliCard,
  cliRowText,
  HourCard,
  LongestCard,
  NowCard,
  ProjectsCard,
  TokensCard,
} from './StatsCards';
import css from './StatsPage.module.css';
import {
  busiestCell,
  cellLabels,
  type Isolate,
  indexHours,
  isolated,
  type StatsWeek,
  sameIsolate,
  spanLine,
  statsWeek,
  timeText,
  topProjects,
} from './statsData';
import { st } from './strings';
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
  /**
   * Say under the switch that the last 7 days were chosen because the week is less than a day
   * old (D, F7; the nav's Stats link chooses so). Shown for this visit once true at mount, and
   * `onNoteSeen` is called then, so the next visit does without it.
   */
  note?: boolean;
  onNoteSeen?(): void;
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
  note = false,
  onNoteSeen,
}: StatsPageProps) {
  const { t, locale } = useI18n();
  const entry = useStatsWeek(kind);
  const cache = useWeekCache();
  // The note as the page opened: it stays for this visit while the caller remembers it was seen.
  const [noted] = useState(note);
  const seen = useRef(onNoteSeen);
  seen.current = onNoteSeen;
  useEffect(() => {
    if (noted) seen.current?.();
  }, [noted]);
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
        <span className={css.switchArea}>
          <Switch
            variant="segmented"
            label={st(locale, 'window')}
            value={kind}
            onChange={onWindow}
            options={[
              { value: 'week', label: st(locale, 'thisWeek') },
              { value: '7d', label: st(locale, 'last7') },
            ]}
          />
        </span>
        <span className={css.range}>
          {w
            ? st(locale, 'range', {
                span: spanLine(kind, w.receipt.start, w.receipt.now, locale),
                n: count(w.receipt.sessions, locale),
                p: count(w.receipt.projects, locale),
              })
            : spanLine(kind, weekWindow(kind, now).hourStarts[0] ?? now, now, locale)}
        </span>
        <span className={css.status}>
          <Status entry={entry} updating={updating} locale={locale} onRefresh={refresh} />
        </span>
        <span className={css.printArea}>
          <WeeklyReceiptButton showProbes={showProbes} start={kind} label={st(locale, 'print')} />
        </span>
      </div>
      {noted && kind === '7d' && <p className={css.defaultNote}>{st(locale, 'defaultNote')}</p>}
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

/**
 * When the data is from, and Refresh; or how far a first read got; or why it failed. Only the
 * first read's progress is a live region, and a failure an alert that stays while the week is
 * read again: the minute's re-read says nothing to a screen reader (M4).
 */
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
  // Updating… where Refresh was, once a read takes a moment (N7): a click then would only queue.
  const action = updating ? rt(locale, 'updating') : again;
  // Without a result, a read under way comes first, as in the dialog: the failure it tries again
  // is not said beside it. Until the server says how many sessions there are, only that it is
  // reading them (DR5).
  const first = entry.result ? null : entry.reading;
  const progress = first
    ? first.total > 0
      ? rt(locale, 'reading', { done: first.done, total: first.total })
      : st(locale, 'reading')
    : '';
  // Read before, not again this time: in the figures as they were, older than the time beside it.
  const stale = entry.result?.stats.failed ?? 0;
  return (
    <>
      <span role="status">{progress}</span>
      {first ? null : entry.failed !== null ? (
        <span className={css.failed}>
          {/* The failure alone in the alert: a read starting or ending does not say it again (M4). */}
          <span role="alert">{rt(locale, 'weekFailed', { msg: entry.failed })}</span> · {action}
        </span>
      ) : (
        entry.result && (
          <span>
            {rt(locale, 'asOf', { time: clock(entry.result.asOf) })} ·{' '}
            {stale > 0 && <>{rt(locale, 'notRefreshed', { n: stale })} · </>}
            {action}
          </span>
        )
      )}
    </>
  );
}

/** The cards, empty, while the window is read the first time. */
function Skeleton() {
  return (
    <div className={css.cards} aria-hidden="true" data-skeleton>
      <div className={css.overview} />
      <div className={css.column} data-column="main">
        <div className={css.card} data-area="grid" />
        <div className={css.pair}>
          <div className={css.card} data-area="cli" />
          <div className={css.card} data-area="projects" />
        </div>
        <div className={css.card} data-area="tokens" />
      </div>
      <div className={css.column} data-column="side">
        <div className={css.card} data-area="hour" />
        <div className={css.card} data-area="longest" />
        <div className={css.card} data-area="now" />
      </div>
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
  const { t, locale: L } = useI18n();
  const r = w.receipt;
  const [picked, setPicked] = useState<Cell | null>(null);
  const [pinned, setPinned] = useState<Isolate | null>(null);
  const [hovered, setHovered] = useState<Isolate | null>(null);
  // Pinned, a CLI or project is what the cards show (DR3); hovered, only what the grid previews.
  const cards = useMemo(() => (pinned ? isolated(w, pinned) : w), [w, pinned]);
  const grid = useMemo(() => (hovered ? isolated(w, hovered) : cards), [w, hovered, cards]);
  const labels = useMemo(() => cellLabels(grid, kind, L), [grid, kind, L]);
  const index = useMemo(() => indexHours(cards), [cards]);
  const busiest = useMemo(() => busiestCell(cards), [cards]);
  const selected = picked ?? busiest;
  const projects = useMemo(() => topProjects(w), [w]);
  const elsewhere = useElsewhere(kind === 'week' && r.sessions === 0, showProbes);
  const onPin = useCallback(
    (by: Isolate) => setPinned((p) => (sameIsolate(p, by) ? null : by)),
    [],
  );
  const onElsewhere = useCallback(() => onWindow('7d'), [onWindow]);
  // An isolated CLI or project, by name, with the time its row prints (M1).
  const caption = (by: Isolate, words: 'only' | 'onlyHover') => {
    const row = 'cli' in by ? r.byCli.find((c) => c.agent === by.cli) : null;
    const project = 'project' in by ? projects.find((p) => p.name === by.project) : null;
    return st(L, words, {
      who: 'cli' in by ? agentName(by.cli) : by.project,
      time: row ? cliRowText(w, row, L) : timeText(project?.ms ?? 0, L),
    });
  };
  const top = cards.receipt;
  return (
    // Escape unpins whatever was pinned, from anywhere on the page.
    // biome-ignore lint/a11y/noStaticElementInteractions: a key handler for the page's own Escape
    <div
      className={css.cards}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && pinned) setPinned(null);
      }}
    >
      {/* The window's own figures, whatever is isolated: the receipt's (N6). */}
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
      {/* Two columns, each stacking its own cards, so a short card never holds an empty row. */}
      <div className={css.column} data-column="main">
        <section className={css.card} data-area="grid" aria-labelledby="stats-when">
          <div className={css.cardTop}>
            <h2 id="stats-when" className={`${css.cardHead} section-label`}>
              {st(L, 'when')}
            </h2>
            <Legend locale={L} />
          </div>
          <WeekGrid
            drawn={grid.receipt}
            labels={labels}
            locale={L}
            label={st(L, 'when')}
            selected={selected}
            onSelect={setPicked}
            week={w.result}
          />
          <div className={css.gridFoot}>
            <span>
              {rt(L, 'busiestHour')}{' '}
              <strong>
                {top.busiest
                  ? `${hourOf(top.busiest.at, L)} · ${timeText(top.busiest.ms, L)}`
                  : '—'}
              </strong>
            </span>
            <span>
              {rt(L, 'afterHours')} {/* Whole percents, as the slip prints it. */}
              <strong>
                {top.afterHours === null ? '—' : `${Math.round(top.afterHours * 100)}%`}
              </strong>
            </span>
            <span className={css.caption}>
              {hovered
                ? caption(hovered, 'onlyHover')
                : pinned
                  ? caption(pinned, 'only')
                  : st(L, 'isolateHint')}
            </span>
          </div>
        </section>
        <div className={css.pair}>
          <CliCard w={w} locale={L} pinned={pinned} onHover={setHovered} onPin={onPin} />
          <ProjectsCard
            projects={projects}
            agentMs={r.agentMs}
            locale={L}
            pinned={pinned}
            onHover={setHovered}
            onPin={onPin}
          />
        </div>
        <TokensCard w={w} locale={L} />
      </div>
      <div className={css.column} data-column="side">
        <HourCard
          w={cards}
          index={index}
          kind={kind}
          cell={selected}
          listed={listed}
          locale={L}
          empty={r.sessions === 0}
          elsewhere={elsewhere}
          onElsewhere={onElsewhere}
        />
        <LongestCard w={w} listed={listed} locale={L} />
        <NowCard quotas={quotas} now={now} />
      </div>
    </div>
  );
}

/** The grid's inks, as a key: an hour with none, under 10 minutes, under 40, and 40 or more. */
function Legend({ locale }: { locale: Locale }) {
  return (
    <span className={`${css.legend} figure`} aria-hidden="true">
      <span data-ink="none" />0<span data-ink="low" />
      {'<10'}
      <span data-ink="mid" />
      {'<40'}
      <span data-ink="high" />
      <UiCjk text={`40+ ${st(locale, 'minutes')}`} />
    </span>
  );
}

/** The last 7 days' sessions, read when this week has none: the hour card's way out. */
function useElsewhere(wanted: boolean, showProbes: boolean): number | null {
  const cache = useWeekCache();
  // Only the other window's result: its reads' progress draws nothing here.
  const other = useSyncExternalStore(cache.subscribe, () => cache.get()['7d']?.result ?? null);
  useEffect(() => {
    if (!wanted) return;
    const release = cache.retain('7d');
    cache.request('7d');
    return release;
  }, [cache, wanted]);
  return wanted && other ? listedOnly(other, showProbes).sessions.length : null;
}
