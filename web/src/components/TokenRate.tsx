import { TrendingUp } from 'lucide-react';
import { type CSSProperties, type ReactNode, useCallback, useId, useRef, useState } from 'react';
import type { AgentKind } from '../../../src/core/model.js';
import {
  countedSince,
  firstCountedIndex,
  hourTotal,
  lastMinute,
  RATE_MINUTES,
  type TokenRate as Rate,
  type RateCoverage,
  type RateKind,
  rateAgents,
  rateCoverage,
  ratePerMinute,
  rateSeries,
} from '../../../src/shared/rate.js';
import { useRate } from '../data/store';
import { type MessageKey, useI18n } from '../i18n';
import { AGENT_TONES, agentColors, agentName } from '../lib/agent-names';
import { DASH, formatCompact } from '../lib/format';
import { AgentTag } from './AgentTag';
import { CompactFigure, UiCjk } from './CompactFigure';
import { useOnePopover, usePopoverDismiss } from './popover';
import { RateChart, Sparkline } from './RateCharts';
import css from './TokenRate.module.css';

/** "15:22": when counting began, in the viewer's clock. */
const clockOf = (d: Date, locale: string) =>
  new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    d,
  );

const KIND_LABEL: Record<RateKind, MessageKey> = {
  cacheRead: 'tokens.cacheRead',
  cacheWrite: 'tokens.cacheWrite',
  input: 'tokens.input',
  output: 'tokens.output',
};
/** The tape's order, as Where tokens went draws it: the largest share first. */
const KIND_ORDER: RateKind[] = ['cacheRead', 'cacheWrite', 'input', 'output'];
const KIND_COLOUR: Record<RateKind, string> = {
  cacheRead: 'var(--tok-cache-read)',
  cacheWrite: 'var(--tok-cache-write)',
  input: 'var(--tok-input)',
  output: 'var(--tok-output)',
};

/** A scope's rate as one line of text: "1.44M/min", "≈1.2M/min" when it misses some, or "—". */
export function rateText(
  rate: Rate,
  agent: AgentKind | null,
  locale: string,
  perMin: string,
): string {
  const avg = ratePerMinute(rate, { agent });
  if (avg === 0) return DASH;
  const { running, counted } = rateCoverage(rate, agent);
  return `${counted < running ? '≈' : ''}${formatCompact(avg, locale)}${perMin}`;
}

/** The figures of one scope (every CLI, or one), as the bar and the popover show them. */
export function useRateFigures(rate: Rate, agent: AgentKind | null) {
  const { t, intl } = useI18n();
  const scope = { agent };
  const avg = ratePerMinute(rate, scope);
  const last = lastMinute(rate, scope);
  const hour = hourTotal(rate, scope);
  const { running, counted } = rateCoverage(rate, agent);
  const partial = counted < running;
  const fmt = (n: number) => formatCompact(n, intl);
  // Counting began within the hour: "the last hour" is only the time since.
  const sinceDate = countedSince(rate);
  const since = sinceDate ? clockOf(sinceDate, intl) : null;
  const where = agent ? t('rate.labelScope', { agent: agentName(agent) }) : '';
  const label =
    [
      avg > 0
        ? t('rate.labelAvg', { scope: where, avg: fmt(avg) })
        : t('rate.labelIdle', { scope: where }),
      avg > 0 && last !== null ? t('rate.labelLast', { last: fmt(last) }) : null,
      since
        ? t('rate.labelSince', { hour: fmt(hour), time: since })
        : t('rate.labelHour', { hour: fmt(hour) }),
    ]
      .filter(Boolean)
      .join(t('rate.sep')) + (partial ? t('rate.labelPartial', { counted, running }) : '');
  const partialTitle = t('rate.partial', { counted, running });
  return {
    avg,
    last,
    hour,
    running,
    counted,
    partial,
    partialTitle,
    since,
    idle: avg === 0,
    fmt,
    label,
  };
}

interface Props {
  /** The machine's token rate; the store's when not given. */
  rate?: Rate | null;
  /** The CLI the bar shows; null for all of them. Remembered by the caller. */
  agent: AgentKind | null;
  onAgent(agent: AgentKind | null): void;
  /** A session is open: below 900px its readout carries the figure instead. */
  sessionOpen: boolean;
}

/**
 * The machine's token rate in the top bar: a trend glyph, the trailing 5-minute average in tokens
 * a minute, and the hour as a line. Its popover filters by CLI and splits the rate by CLI and by
 * token kind. Nothing here is a status: no accent, no colour but the agent tags and token kinds.
 * It reads the rate itself, so a rate push re-renders it and not the page.
 */
export function TokenRate({ rate: given, agent, onAgent, sessionOpen }: Props) {
  const { t } = useI18n();
  const stored = useRate();
  const rate = given !== undefined ? given : stored;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const close = useCallback(() => setOpen(false), []);
  useOnePopover('rate', open, close);
  usePopoverDismiss(ref, open, close, buttonRef);
  if (!rate) return null;
  return (
    <div className={css.wrap} ref={ref} data-session={sessionOpen || undefined}>
      <Instrument
        rate={rate}
        agent={agent}
        open={open}
        popoverId={popoverId}
        buttonRef={buttonRef}
        onToggle={() => setOpen(!open)}
      />
      {open && (
        <div id={popoverId} className={css.popover} role="dialog" aria-label={t('rate.title')}>
          <Details rate={rate} agent={agent} onAgent={onAgent} />
        </div>
      )}
    </div>
  );
}

/** "≈" before a figure that misses running sessions, its title saying how many it counts. */
function Approx({ title }: { title: string }) {
  return (
    <span className={css.approx} title={title}>
      ≈
    </span>
  );
}

function Instrument({
  rate,
  agent,
  open,
  popoverId,
  buttonRef,
  onToggle,
}: {
  rate: Rate;
  agent: AgentKind | null;
  open: boolean;
  popoverId: string;
  buttonRef: React.Ref<HTMLButtonElement>;
  onToggle(): void;
}) {
  const { t } = useI18n();
  const f = useRateFigures(rate, agent);
  return (
    <button
      ref={buttonRef}
      type="button"
      className={css.bar}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-controls={open ? popoverId : undefined}
      aria-label={f.label}
      onClick={onToggle}
    >
      <TrendingUp size={14} className={css.glyph} aria-hidden="true" />
      {agent && <AgentTag kind={agent} />}
      <span className={`${css.figure} figure`} data-idle={f.idle || undefined}>
        {f.idle ? (
          DASH
        ) : (
          <>
            {f.partial && <Approx title={f.partialTitle} />}
            <CompactFigure value={f.fmt(f.avg)} />
            <span className={css.unit}>
              <UiCjk text={t('rate.perMin')} />
            </span>
          </>
        )}
      </span>
      <Sparkline
        className={css.spark}
        values={rateSeries(rate, { agent })}
        width={60}
        height={16}
        from={firstCountedIndex(rate)}
      />
    </button>
  );
}

/** A message with `{time}` set in the mono face: "SINCE 15:22", "15:22 起合计". */
function WithTime({ text, time }: { text: string; time: string }): ReactNode {
  const [before, after] = text.split('\u0001');
  return (
    <>
      {before}
      <span className="figure">{time}</span>
      {after}
    </>
  );
}

function Details({
  rate,
  agent,
  onAgent,
}: {
  rate: Rate;
  agent: AgentKind | null;
  onAgent(agent: AgentKind | null): void;
}) {
  const { t, intl } = useI18n();
  const f = useRateFigures(rate, agent);
  const from = firstCountedIndex(rate);
  const series = rateSeries(rate, { agent });
  // CLIs with anything in the hour, in the tags' fixed order. Chips: every CLI spending now, and
  // always the chosen one, so a filter can be undone whatever the data does.
  const present = sortAgents(rateAgents(rate));
  const chips = sortAgents([
    ...new Set([
      ...present.filter((a) => ratePerMinute(rate, { agent: a }) > 0),
      ...(agent ? [agent] : []),
    ]),
  ]);
  const total = ratePerMinute(rate);
  const kinds = KIND_ORDER.map((kind) => [kind, ratePerMinute(rate, { agent, kind })] as const);
  const kindTotal = kinds.reduce((sum, [, n]) => sum + n, 0);
  const share = (n: number, of: number) =>
    new Intl.NumberFormat(intl, { style: 'percent', maximumFractionDigits: 0 }).format(
      of > 0 ? n / of : 0,
    );
  const rows = present
    .map((a) => {
      const values = rateSeries(rate, { agent: a });
      const lastSpend = values.findLastIndex((n) => n > 0);
      return {
        agent: a,
        avg: ratePerMinute(rate, { agent: a }),
        values,
        quiet: RATE_MINUTES - 1 - lastSpend,
      };
    })
    .sort(
      (a, b) =>
        b.avg - a.avg || hourTotal(rate, { agent: b.agent }) - hourTotal(rate, { agent: a.agent }),
    );
  const peak = Math.max(0, ...series.slice(from));
  const nowTokens = series.at(-1) ?? 0;

  return (
    <>
      <p className={css.head}>
        <span className={css.title}>{t('rate.title')}</span>
        <span className={css.scope}>
          {agent ? t('rate.scopeOne', { agent: agentName(agent) }) : t('rate.scopeAll')}
        </span>
      </p>
      {/* biome-ignore lint/a11y/useSemanticElements: a row of filter toggles, not a form fieldset */}
      <div className={css.chips} role="group" aria-label={t('rate.filter')}>
        <button
          type="button"
          className={css.chip}
          aria-pressed={agent === null}
          title={t('rate.allTitle')}
          onClick={() => onAgent(null)}
        >
          {t('rate.all')}
        </button>
        {chips.map((a) => {
          const { fg, bg, edge } = agentColors(a);
          return (
            <button
              key={a}
              type="button"
              className={css.chip}
              data-agent={a}
              aria-pressed={agent === a}
              title={t('rate.oneTitle', { agent: agentName(a) })}
              style={{ '--tag-fg': fg, '--tag-bg': bg, '--tag-edge': edge } as CSSProperties}
              onClick={() => onAgent(agent === a ? null : a)}
            >
              {agentName(a)}
            </button>
          );
        })}
      </div>
      <div className={css.figures}>
        <div>
          <span className={`${css.label} section-label`}>{t('rate.avg5')}</span>
          <span className={`${css.big} figure`}>
            {f.idle ? (
              DASH
            ) : (
              <>
                {f.partial && <Approx title={f.partialTitle} />}
                <CompactFigure value={f.fmt(f.avg)} />
                <span className={css.bigUnit}>
                  <UiCjk text={t('rate.perMin')} />
                </span>
              </>
            )}
          </span>
        </div>
        <div>
          <span className={`${css.label} section-label`}>{t('rate.lastMinute')}</span>
          <span className={`${css.small} figure`}>
            {f.last === null ? (
              DASH
            ) : (
              <>
                <CompactFigure value={f.fmt(f.last)} />
                <span className={css.unit}>
                  <UiCjk text={t('rate.perMin')} />
                </span>
              </>
            )}
          </span>
        </div>
        <div className={css.right}>
          <span className={`${css.label} section-label`} data-since={f.since ? '' : undefined}>
            {f.since ? (
              <WithTime text={t('rate.sinceTotal', { time: '\u0001' })} time={f.since} />
            ) : (
              t('rate.hour')
            )}
          </span>
          <span className={`${css.small} figure`}>
            <CompactFigure value={f.fmt(f.hour)} />
          </span>
        </div>
      </div>
      <RateChart
        rate={rate}
        values={series}
        from={from}
        locale={intl}
        label={
          f.since
            ? t('rate.chartSince', { time: f.since, peak: f.fmt(peak), now: f.fmt(nowTokens) })
            : t('rate.chart', { peak: f.fmt(peak), now: f.fmt(nowTokens) })
        }
        ticksX={[t('rate.ago60'), t('rate.ago30'), t('rate.now')]}
        sinceLabel={f.since ? t('rate.countingSince', { time: f.since }) : null}
      />
      {rows.length > 0 && (
        <section className={css.section} aria-label={t('rate.byCli')}>
          <p className={css.sectionHead}>
            <span className="section-label">{t('rate.byCli')}</span>
            <span>{t('rate.byCliNote')}</span>
          </p>
          <ul className={css.rows}>
            {rows.map((r) => (
              <li
                key={r.agent}
                className={css.row}
                aria-label={t('rate.row', {
                  agent: agentName(r.agent),
                  rate: r.avg > 0 ? f.fmt(r.avg) : DASH,
                  share: share(r.avg, total),
                })}
              >
                <span className={css.rowName}>
                  <AgentTag kind={r.agent} />
                  {r.avg === 0 && (
                    <span className={css.quiet}>{t('rate.quiet', { n: r.quiet })}</span>
                  )}
                </span>
                <span className={css.miniCell}>
                  <Sparkline
                    className={css.mini}
                    values={r.values}
                    width={48}
                    height={12}
                    from={from}
                  />
                </span>
                <span className={`${css.rowRate} figure`}>
                  {r.avg > 0 ? (
                    <>
                      <CompactFigure value={f.fmt(r.avg)} />
                      <span className={css.unit}>
                        <UiCjk text={t('rate.perMin')} />
                      </span>
                    </>
                  ) : (
                    DASH
                  )}
                </span>
                <span className={`${css.rowShare} figure`}>{share(r.avg, total)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className={css.section} aria-label={t('rate.byKind')}>
        <p className={css.sectionHead}>
          <span className="section-label">{t('rate.byKind')}</span>
          <span>
            {agent ? t('rate.byKindNoteOne', { agent: agentName(agent) }) : t('rate.byKindNoteAll')}
          </span>
        </p>
        <div className={css.tape} aria-hidden="true">
          {kinds.map(([kind, n]) =>
            n > 0 ? (
              <span key={kind} style={{ flexGrow: n, background: KIND_COLOUR[kind] }} />
            ) : null,
          )}
        </div>
        <ul className={css.legend}>
          {kinds.map(([kind, n]) => (
            <li key={kind}>
              <span
                className={css.swatch}
                style={{ background: KIND_COLOUR[kind] }}
                aria-hidden="true"
              />
              <span className={css.kind}>{t(KIND_LABEL[kind])}</span>
              <span className="figure">
                <CompactFigure value={f.fmt(n)} />
              </span>
              <span className={`${css.kindShare} figure`}>{share(n, kindTotal)}</span>
            </li>
          ))}
        </ul>
      </section>
      <p className={css.footer}>
        {f.running > 0
          ? t('rate.coverage', { counted: f.counted, running: f.running })
          : t('rate.coverageNone')}{' '}
        {perTurn(rate.coverage, agent).map((a) => (
          <span key={a}>{t('rate.perTurn', { agent: agentName(a) })} </span>
        ))}
        {t('rate.footer')}
      </p>
    </>
  );
}

/** Running agents that report a turn's tokens only as it ends, in scope, in tag order. */
function perTurn(coverage: RateCoverage, agent: AgentKind | null): AgentKind[] {
  return sortAgents(
    (Object.keys(coverage.agents) as AgentKind[]).filter((a) => {
      const c = coverage.agents[a];
      return !!c && c.reporting === 'turn' && c.running > 0 && (agent === null || agent === a);
    }),
  );
}

/** The agent tags' fixed order, others after them by name: rows and chips do not reshuffle. */
function sortAgents(agents: AgentKind[]): AgentKind[] {
  const known = AGENT_TONES.filter((a) => agents.includes(a));
  const others = agents.filter((a) => !(AGENT_TONES as readonly string[]).includes(a)).sort();
  return [...known, ...others];
}
