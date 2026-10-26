import { type PointerEvent, useState } from 'react';
import type { SessionSummary } from '../../../src/core/model.js';
import type { RovingItemProps } from '../data/useRovingFocus';
import { translateParts, useI18n } from '../i18n';
import { agentName } from '../lib/agent-names';
import { formatCompact, formatRelative } from '../lib/format';
import { isRunning } from '../lib/sessions';
import { ActivityLine } from './ActivityLine';
import { AgentTag } from './AgentTag';
import { CompactFigure } from './CompactFigure';
import css from './SessionRow.module.css';

interface Props {
  session: SessionSummary;
  selected: boolean;
  now: number;
  /** `compact` in the sidebar; `card` on Home's board. */
  density?: 'compact' | 'card';
  /** Set when the session's glassbox run failed: its error, or null when it gave none. */
  failure?: string | null;
  roving?: RovingItemProps;
  onSelect(id: string): void;
}

/**
 * One session as a row. Flush, a hairline under it, an ink bar when it is the one open; its
 * lines cut with an ellipsis inside the row, so its focus ring frames it.
 * - `compact`: the title, then what it is doing (or its state and age), its output tokens and
 *   its agent tag at the right edge.
 * - `card`: the agent tag, its project and the title, then what it is doing with its clock (or
 *   its state and age) and its output tokens.
 * The figure is the output ("1.2M out"): a total would be mostly cache reads, which say little.
 * Nothing is shown while it is zero.
 */
export function SessionRow({
  session: s,
  selected,
  now,
  density = 'compact',
  failure,
  roving,
  onSelect,
}: Props) {
  const { t, intl, locale } = useI18n();
  // Whether the row cut its text short when the pointer arrived: only then does the tooltip
  // repeat the row's text (whole), so a screen reader does not hear it twice.
  const [clipped, setClipped] = useState(false);
  const title = s.title ?? t('sidebar.untitled');
  const running = isRunning(s);
  const failed = failure !== undefined && !running;
  const state = failed
    ? [t('status.error'), failure].filter(Boolean).join(': ')
    : t(`live.${s.live}`);
  const when = formatRelative(s.updatedAt, now, intl);
  const figure = s.usage && s.usage.output > 0 ? formatCompact(s.usage.output, intl) : null;
  // Said in full ("42K output tokens"): the tooltip, and what a screen reader hears.
  const tokens = figure ? t('session.outputTokens', { n: figure }) : null;
  const tip = clipped
    ? [title, [agentName(s.agent), state, when, tokens].filter(Boolean).join(' · '), s.cwd]
        .filter(Boolean)
        .join('\n')
    : (s.cwd ?? undefined);
  const button = {
    type: 'button' as const,
    className: css.row,
    'data-density': density,
    ...roving,
    'aria-current': selected ? ('true' as const) : undefined,
    title: tip,
    onPointerEnter: (e: PointerEvent<HTMLButtonElement>) =>
      setClipped(
        [...e.currentTarget.querySelectorAll<HTMLElement>('[data-clip]')].some(
          (el) => el.scrollWidth > el.clientWidth,
        ),
      ),
    onClick: () => onSelect(s.id),
  };
  // A running session says what it is doing, which is newer than any age.
  const showAge = !(running && s.activity);

  if (density === 'card')
    return (
      <button {...button}>
        <span className={css.head}>
          <AgentTag kind={s.agent} />
          {s.project && (
            <span className={css.project} title={s.project}>
              <span className={css.name}>{s.project}</span>
              <span className={css.slash}> /</span>
            </span>
          )}
          <span className={css.title} data-clip>
            {title}
          </span>
        </span>
        <span className={css.meta}>
          <ActivityLine session={s} failure={failure} density="card" />
          {showAge && (
            <>
              <span className={css.sep}> · </span>
              <span className={css.age}>{when}</span>
            </>
          )}
          {figure && (
            <>
              <span className={css.sep}> · </span>
              <span className={css.tokens} aria-hidden="true">
                {translateParts(locale, 'session.out', { n: figure }, ['n']).map((p) =>
                  typeof p === 'string' ? p : <CompactFigure key="n" value={p.value} />,
                )}
              </span>
              <span className="visually-hidden">{tokens}</span>
            </>
          )}
        </span>
      </button>
    );

  return (
    <button {...button}>
      <span className={css.title} data-clip>
        {title}
      </span>
      <span className={css.meta}>
        <ActivityLine session={s} failure={failure} density="compact" />
        <span className={css.when} data-clip data-age={showAge || undefined}>
          {showAge && (
            <>
              <span className={css.sep}>·</span> {when}
            </>
          )}
          {figure && (
            <>
              {' '}
              <span className={css.sep}>·</span>{' '}
              <span aria-hidden="true">
                {translateParts(locale, 'session.out', { n: figure }, ['n']).map((p) =>
                  typeof p === 'string' ? p : <CompactFigure key="n" value={p.value} />,
                )}
              </span>
              <span className="visually-hidden">{tokens}</span>
            </>
          )}
        </span>
        <AgentTag kind={s.agent} />
      </span>
    </button>
  );
}
