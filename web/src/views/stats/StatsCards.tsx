/**
 * The Stats page's cards (D4): the hour, by CLI, top projects, longest sessions, tokens and right
 * now. The receipt's words where the slip has them (`rt`), so the two read alike; the page's own
 * for the rest (`st`). A session is a link only while the session list has it (R32). Each card
 * draws again only when its own figures change: a hover in the grid draws none of them.
 */
import { Fragment, memo, type RefObject, useEffect, useRef, useState } from 'react';
import type { QuotaSnapshot, QuotaWindow } from '../../../../src/core/model.js';
import {
  burnSince,
  burnWindow,
  type QuotaBurn,
  topBurn,
} from '../../../../src/shared/quota-burn.js';
import { firstCountedIndex, ratePerMinute, rateSeries } from '../../../../src/shared/rate.js';
import type { WeekWindowKind } from '../../../../src/shared/week.js';
import { AgentTag } from '../../components/AgentTag';
import { UiCjk } from '../../components/CompactFigure';
import { sharePct } from '../../components/QuotaBurn';
import burnCss from '../../components/QuotaBurn.module.css';
import { Sparkline } from '../../components/RateCharts';
import { count, partsText } from '../../components/receipt/format';
import { rt } from '../../components/receipt/strings';
import { unreportedLine } from '../../components/receipt/week';
import { cliParts, shareText } from '../../components/receipt/weekFigures';
import { type BurnAsk, useListedIds, useQuotaBurns } from '../../data/quotaBurn';
import { useRate } from '../../data/store';
import { type Locale, useI18n } from '../../i18n';
import { agentName } from '../../lib/agent-names';
import { formatCompact, formatPercent, formatResetTime } from '../../lib/format';
import { formatUsdShort } from '../../lib/prices';
import { providerShortName } from '../../lib/provider-names';
import { quotaWindowName } from '../../lib/quota';
import { paceOf, quotaLevel } from '../../lib/quota-pace';
import { sessionLink } from '../../router';
import mcp from './Mcp.module.css';
import css from './StatsPage.module.css';
import {
  type HourIndex,
  hourOfCell,
  hourSpan,
  type Isolate,
  longestSessions,
  mcpServers,
  type SessionLine,
  type StatsWeek,
  sameIsolate,
  timeText,
} from './statsData';
import { st } from './strings';
import type { Cell } from './WeekGrid';

/** A card's head: its name, in capitals, and what its figures are, muted. */
export function Head({ id, name, note }: { id: string; name: string; note?: string }) {
  return (
    <h2 id={id} className={css.cardHead}>
      <span className="section-label">{name}</span>
      {note && <span className={css.note}>{note}</span>}
    </h2>
  );
}

/** A card with nothing to list: one line, a dash (DR4). */
const None = () => <p className={css.none}>—</p>;

/** Sessions as rows: the title (a link while listed), its project and CLI, and its time. */
function SessionRows({
  rows,
  listed,
  locale,
  listRef,
}: {
  rows: SessionLine[];
  listed: Set<string>;
  locale: Locale;
  listRef?: RefObject<HTMLUListElement | null>;
}) {
  const { t } = useI18n();
  return (
    <ul ref={listRef} className={css.sessions}>
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

/** An hour's sessions listed before "N more" (eleven have worked in one hour). */
const HOUR_ROWS = 8;

/**
 * An hour's sessions: the first `HOUR_ROWS`, then "N more", which shows the rest and moves focus
 * on to the first of them, as the sidebar's groups do. Keyed by the hour, so another hour
 * starts folded.
 */
function HourSessions({
  rows,
  listed,
  locale,
}: {
  rows: SessionLine[];
  listed: Set<string>;
  locale: Locale;
}) {
  const [unfolded, setUnfolded] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!unfolded) return;
    const first = listRef.current?.children[HOUR_ROWS];
    if (!(first instanceof HTMLElement)) return;
    // Its title is a link while the session list has it; else the row itself takes the focus.
    const link = first.querySelector('a');
    if (link) link.focus();
    else {
      first.tabIndex = -1;
      first.focus();
    }
  }, [unfolded]);
  const more = unfolded ? 0 : Math.max(0, rows.length - HOUR_ROWS);
  return (
    <>
      <SessionRows
        rows={more > 0 ? rows.slice(0, HOUR_ROWS) : rows}
        listed={listed}
        locale={locale}
        listRef={listRef}
      />
      {more > 0 && (
        <button type="button" className={css.link} onClick={() => setUnfolded(true)}>
          {st(locale, 'more', { n: more })}
        </button>
      )}
    </>
  );
}

/**
 * The hour selected in the grid: when, its agent time, its sessions most minutes first; with a
 * CLI or project pinned, only its own (DR3). With no session in the window, says so, and points
 * to the other window when that has some.
 */
export const HourCard = memo(function HourCard(p: {
  /** The week as the cards show it: the window's, or the pinned CLI's or project's alone. */
  w: StatsWeek;
  index: HourIndex;
  kind: WeekWindowKind;
  cell: Cell | null;
  listed: Set<string>;
  locale: Locale;
  /** The window holds no session at all. */
  empty: boolean;
  /** The last 7 days' sessions, when this week has none: the way out. */
  elsewhere: number | null;
  onElsewhere(): void;
}) {
  const L = p.locale;
  const gridCell = p.cell && p.w.receipt.grid[p.cell.row]?.[p.cell.col];
  const hour = gridCell ? hourOfCell(p.w, gridCell, p.index) : null;
  if (p.empty)
    return (
      <section className={css.card} data-area="hour" aria-labelledby="stats-hour">
        <h2 id="stats-hour" className={css.hourTitle}>
          {rt(L, p.kind === 'week' ? 'noSessions' : 'noSessions7')}
        </h2>
        {p.elsewhere !== null && p.elsewhere > 0 && (
          <button type="button" className={css.link} onClick={p.onElsewhere}>
            {st(L, 'wayOut', { n: p.elsewhere })}
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
              ? // Each part whole ("Claude Code 1 小时 22 分"): the line breaks only between them.
                st(L, 'hourLine', {
                  time: timeText(hour.ms, L),
                  n: hour.sessions.length,
                  cli: agentName(hour.topCli.agent),
                  cliTime: timeText(hour.topCli.ms, L),
                })
                  .split(' · ')
                  .map((part, i) => (
                    <Fragment key={part}>
                      {i > 0 && ' · '}
                      <span className={css.keep}>{part}</span>
                    </Fragment>
                  ))
              : st(L, 'hourIdle')}
          </p>
          <HourSessions key={hour.start} rows={hour.sessions} listed={p.listed} locale={L} />
        </>
      ) : (
        <h2 id="stats-hour" className={css.hourTitle}>
          {st(L, 'noTime')}
        </h2>
      )}
      <p className={css.hint}>{st(L, 'hourHint')}</p>
    </section>
  );
});

/** How a row isolates its CLI or project in the grid: hovered for a look, clicked to pin. */
interface IsolateProps {
  pinned: Isolate | null;
  onHover(by: Isolate | null): void;
  onPin(by: Isolate): void;
}

function BarRow({
  by,
  name,
  value,
  aside,
  share,
  pinned,
  onHover,
  onPin,
}: IsolateProps & {
  by: Isolate;
  name: string;
  value: string;
  aside?: string;
  share: number;
}) {
  return (
    <li>
      <button
        type="button"
        className={css.barRow}
        aria-pressed={sameIsolate(pinned, by)}
        onPointerEnter={() => onHover(by)}
        onPointerLeave={() => onHover(null)}
        onClick={() => onPin(by)}
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

/** A CLI's time as its By CLI row prints it: its minutes as the receipt shares them out (DR10). */
export const cliRowText = (w: StatsWeek, row: StatsWeek['receipt']['byCli'][number], L: Locale) =>
  partsText(cliParts(row, w.receipt.cliUnit, L));

/** By CLI: each CLI's agent time and share, as the receipt prints them (DR4, DR8, DR10). */
export const CliCard = memo(function CliCard({
  w,
  locale,
  ...iso
}: IsolateProps & { w: StatsWeek; locale: Locale }) {
  const rows = w.receipt.byCli;
  return (
    <section className={css.card} data-area="cli" aria-labelledby="stats-cli">
      <Head id="stats-cli" name={rt(locale, 'byCli')} note={st(locale, 'agentTime')} />
      {rows.length > 0 ? (
        <>
          <ul className={css.bars}>
            {rows.map((c) => (
              <BarRow
                key={c.agent}
                by={{ cli: c.agent }}
                name={agentName(c.agent)}
                value={cliRowText(w, c, locale)}
                aside={c.share === null ? undefined : shareText(c.share)}
                share={c.share === null ? 0 : c.share === '<1' ? 1 : c.share}
                {...iso}
              />
            ))}
          </ul>
          <p className={css.hint}>{st(locale, 'cliHint')}</p>
        </>
      ) : (
        <None />
      )}
    </section>
  );
});

/** Top projects: agent time and sessions, the bar its share of the week's agent time. */
export const ProjectsCard = memo(function ProjectsCard({
  projects,
  agentMs,
  locale,
  ...iso
}: IsolateProps & {
  projects: { name: string; ms: number; sessions: number }[];
  agentMs: number;
  locale: Locale;
}) {
  return (
    <section className={css.card} data-area="projects" aria-labelledby="stats-projects">
      <Head id="stats-projects" name={st(locale, 'projects')} note={st(locale, 'projectsNote')} />
      {projects.length > 0 ? (
        <ul className={css.bars}>
          {projects.map((p) => (
            <BarRow
              key={p.name}
              by={{ project: p.name }}
              name={p.name}
              value={timeText(p.ms, locale)}
              aside={count(p.sessions, locale)}
              share={agentMs > 0 ? (p.ms / agentMs) * 100 : 0}
              {...iso}
            />
          ))}
        </ul>
      ) : (
        <None />
      )}
    </section>
  );
});

/** Longest sessions: five, by their own clock (session time, as the slip's LONGEST). */
export const LongestCard = memo(function LongestCard({
  w,
  listed,
  locale,
}: {
  w: StatsWeek;
  listed: Set<string>;
  locale: Locale;
}) {
  const rows = longestSessions(w);
  return (
    <section className={css.card} data-area="longest" aria-labelledby="stats-longest">
      <Head id="stats-longest" name={st(locale, 'longest')} note={st(locale, 'longestNote')} />
      {rows.length > 0 ? <SessionRows rows={rows} listed={listed} locale={locale} /> : <None />}
    </section>
  );
});

const KINDS = ['cacheRead', 'cacheWrite', 'uncached', 'output'] as const;
const KIND_COLOUR = {
  cacheRead: 'var(--tok-cache-read)',
  cacheWrite: 'var(--tok-cache-write)',
  uncached: 'var(--tok-input)',
  output: 'var(--tok-output)',
};

/** Tokens: the four kinds as a tape and as figures, as the receipt counts them. */
export const TokensCard = memo(function TokensCard({
  w,
  locale,
}: {
  w: StatsWeek;
  locale: Locale;
}) {
  const { intl } = useI18n();
  const tk = w.receipt.tokens;
  const fmt = (n: number) => formatCompact(n, intl);
  const sum = tk.cacheRead + tk.cacheWrite + tk.uncached + tk.output;
  const note = unreportedLine(w.receipt, locale, () => true);
  // What the same tokens would cost on the API: an estimate from the price table in Settings.
  const leftOut =
    tk.cost.unpriced.length > 0 ? tk.cost.unpriced.join(', ') : st(locale, 'costNoModel');
  const costTitle = tk.cost.partial
    ? `${st(locale, 'costTitle')} · ${st(locale, 'costLeftOut', { models: leftOut })}`
    : st(locale, 'costTitle');
  return (
    <section className={css.card} data-area="tokens" aria-labelledby="stats-tokens">
      <Head id="stats-tokens" name={rt(locale, 'tokens')} note={st(locale, 'tokensNote')} />
      {w.receipt.sessions === 0 ? (
        <None />
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
                      <UiCjk text={st(locale, 'thinking', { n: fmt(tk.thinking) })} />
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
            {/* The total and its cost, at the right as one: short of room they go under
                together, never the cost alone. */}
            <div className={css.sums}>
              <div className={css.figure} data-total>
                <span className={`${css.value} figure`}>
                  <UiCjk text={fmt(tk.total)} />
                </span>
                <span className="section-label">{rt(locale, 'total')}</span>
              </div>
              <div className={css.figure} data-cost title={costTitle}>
                <span className={`${css.value} figure`}>
                  {tk.cost.priced ? `≈ ${formatUsdShort(tk.cost.usd, intl)}` : '—'}
                </span>
                <span className="section-label">{st(locale, 'apiCost')}</span>
              </div>
            </div>
          </div>
          {note && <p className={css.hint}>{note}</p>}
        </>
      ) : (
        <p className={css.hint}>{rt(locale, 'notReported')}</p>
      )}
    </section>
  );
});

/** A weekday's short name in the app's language, its formatter made once. */
const weekdays = new Map<string, Intl.DateTimeFormat>();
const weekdayIn = (intl: string) => {
  let f = weekdays.get(intl);
  if (!f) {
    f = new Intl.DateTimeFormat(intl, { weekday: 'short' });
    weekdays.set(intl, f);
  }
  return f;
};

/**
 * Right now: the machine's token rate as it moves, and each plan's use, a row a provider as the
 * top bar's meters: the window closest to its limit (one past its reset is history, not use).
 */
export const NowCard = memo(function NowCard({
  quotas,
  now,
}: {
  quotas: QuotaSnapshot[];
  now: number;
}) {
  const { t, locale, intl } = useI18n();
  const rate = useRate();
  const avg = rate ? ratePerMinute(rate, { agent: null }) : 0;
  const resets = (iso: string) => {
    const { date, clock } = formatResetTime(iso, now, intl);
    return st(locale, 'resets', {
      time: date === null ? clock : weekdayIn(intl).format(Date.parse(iso)),
    });
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
        // Coloured as the top bar's meter: near the limit, or reaching it before the reset.
        level: quotaLevel(top, paceOf(top, now, q.stale)),
        stale: q.stale,
        reset: top.resetsAt ? resets(top.resetsAt) : st(locale, 'noReset'),
      },
    ];
  });
  return (
    <section className={css.card} data-area="now" aria-labelledby="stats-now">
      <h2 id="stats-now" className={css.cardHead}>
        <span className="section-label">{st(locale, 'now')}</span>
        <span className={css.live}>{st(locale, 'live')}</span>
      </h2>
      <div className={css.rate}>
        <span className={`${css.rateFigure} figure`}>
          <UiCjk text={avg > 0 ? formatCompact(avg, intl) : '—'} />
        </span>
        <span className={css.note}>{st(locale, 'perMin')}</span>
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
              data-level={r.level}
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
        <p className={css.hint}>{st(locale, 'noQuota')}</p>
      )}
      <BurnLine quotas={quotas} now={now} />
    </section>
  );
});

/** Sessions named on Right now's line. */
const BURN_LINE_ROWS = 3;

/**
 * Who used the plan of the provider closest to a limit (as the top bar's lead meter) of those
 * glassbox saw any use of, on one line under the meters: the top three sessions of its listed
 * window (its 5-hour one when it has one) and their shares, each a link while listed; the quota's
 * details list more. Read again each minute.
 */
function BurnLine({ quotas, now }: { quotas: QuotaSnapshot[]; now: number }) {
  const { t, locale } = useI18n();
  const topPct = (q: QuotaSnapshot) =>
    Math.max(
      -1,
      ...q.windows
        .filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > now)
        .map((w) => w.usedPercent),
    );
  // Closest to a limit first; the first of them with a list is named.
  const candidates = quotas
    .filter(
      (q, i) => burnWindow(q, now) && quotas.findIndex((o) => o.provider === q.provider) === i,
    )
    .sort((a, b) => topPct(b) - topPct(a));
  const asks: BurnAsk[] = candidates.map((q) => ({
    provider: q.provider,
    since: burnSince(q, now),
  }));
  const states = useQuotaBurns(asks, true, Math.floor(now / 60_000));
  const listed = useListedIds();
  let shown: { lead: QuotaSnapshot; window: QuotaWindow; burn: QuotaBurn } | null = null;
  for (const q of candidates) {
    const state = states.get(q.provider);
    const window = burnWindow(q, now);
    if (window && state?.status === 'ok' && state.burn.sessions.length > 0) {
      shown = { lead: q, window, burn: state.burn };
      break;
    }
  }
  if (!shown) return null;
  const { lead, window, burn } = shown;
  const { top } = topBurn(burn.sessions, BURN_LINE_ROWS);
  const hint = st(locale, burn.counted === 'requests' ? 'burnHintRequests' : 'burnHint');
  return (
    <p className={burnCss.line} title={hint}>
      <span className={burnCss.lead}>
        {st(locale, 'burnLead', {
          name: providerShortName(lead.provider),
          window: quotaWindowName(window, t),
        })}
      </span>{' '}
      <span className={burnCss.items}>
        {top.map((s, i) => {
          const title = s.title ?? t('sidebar.untitled');
          return (
            <span key={s.id} className={burnCss.item}>
              {i > 0 && <span className={burnCss.sep}> · </span>}
              {listed === null || listed.has(s.id) ? (
                <a href={sessionLink(s.id)} className={burnCss.itemName}>
                  {title}
                </a>
              ) : (
                <span className={burnCss.itemName}>{title}</span>
              )}{' '}
              <span className={`${burnCss.itemShare} figure`}>{sharePct(s.share)}</span>
            </span>
          );
        })}
      </span>
    </p>
  );
}
// Package F (round 3): MCP servers.

/**
 * MCP servers: the window's servers by calls, each with its failures in the error tone and its
 * calls' time; the bar is its calls against the busiest server's. Says so when none was called.
 */
export const McpCard = memo(function McpCard({ w, locale }: { w: StatsWeek; locale: Locale }) {
  const { intl } = useI18n();
  const rows = mcpServers(w);
  const top = rows[0]?.calls ?? 0;
  return (
    <section className={css.card} data-area="mcp" aria-labelledby="stats-mcp">
      <Head id="stats-mcp" name={st(locale, 'mcp')} note={st(locale, 'mcpNote')} />
      {rows.length > 0 ? (
        <ul className={mcp.servers}>
          {rows.map((s) => (
            <li
              key={s.server}
              className={mcp.server}
              title={st(locale, 'mcpTitle', { n: s.resultChars.toLocaleString(intl) })}
            >
              <span className={mcp.serverName} data-name>
                {s.server}
              </span>
              <span className={mcp.serverValue}>
                <span className={`${mcp.serverMeta} figure`}>
                  <UiCjk text={st(locale, 'mcpCalls', { n: s.calls })} />
                </span>
                {s.failures > 0 && (
                  <span className={`${mcp.failed} figure`} data-failed>
                    <UiCjk text={st(locale, 'mcpFailed', { n: s.failures })} />
                  </span>
                )}
                <span className="figure">
                  <UiCjk text={timeText(s.ms, locale)} />
                </span>
              </span>
              <span className={mcp.serverTrack} aria-hidden="true">
                <span style={{ width: `${top > 0 ? (s.calls / top) * 100 : 0}%` }} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={css.hint}>
          {st(locale, w.result.window.kind === 'week' ? 'mcpNone' : 'mcpNone7')}
        </p>
      )}
    </section>
  );
});
