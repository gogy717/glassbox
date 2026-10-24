import { useState } from 'react';
import type { SessionSummary } from '../../../src/core/model.js';
import { totalTokens } from '../../../src/core/usage.js';
import type { RovingItemProps } from '../data/useRovingFocus';
import { useI18n } from '../i18n';
import { agentName } from '../lib/agent-names';
import { formatCompact, formatRelative } from '../lib/format';
import { AgentTag } from './AgentTag';
import { CompactFigure } from './CompactFigure';
import css from './SessionRow.module.css';
import { LiveDot } from './Status';

interface Props {
  session: SessionSummary;
  selected: boolean;
  now: number;
  /** `compact` in the sidebar; Home's board adds `card` (W6). */
  density?: 'compact';
  roving?: RovingItemProps;
  onSelect(id: string): void;
}

/**
 * One session as a row: the title, then its state, age, token count and agent tag. Flush, a
 * hairline under it, an ink bar when it is the one open; both lines cut with an ellipsis inside
 * the row, so its focus ring frames it.
 */
export function SessionRow({
  session: s,
  selected,
  now,
  density = 'compact',
  roving,
  onSelect,
}: Props) {
  const { t, intl } = useI18n();
  // Whether the row cut its text short when the pointer arrived: only then does the tooltip
  // repeat the row's text (whole), so a screen reader does not hear it twice.
  const [clipped, setClipped] = useState(false);
  const title = s.title ?? t('sidebar.untitled');
  const live = t(`live.${s.live}`);
  const when = formatRelative(s.updatedAt, now, intl);
  const figure = s.usage ? formatCompact(totalTokens(s.usage), intl) : null;
  const tokens = figure ? t('common.tokens', { n: figure }) : null;
  const tip = clipped
    ? [title, [agentName(s.agent), live, when, tokens].filter(Boolean).join(' · '), s.cwd]
        .filter(Boolean)
        .join('\n')
    : (s.cwd ?? undefined);
  return (
    <button
      type="button"
      className={css.row}
      data-density={density}
      {...roving}
      aria-current={selected ? 'true' : undefined}
      title={tip}
      onPointerEnter={(e) =>
        setClipped(
          [...e.currentTarget.querySelectorAll<HTMLElement>('[data-clip]')].some(
            (el) => el.scrollWidth > el.clientWidth,
          ),
        )
      }
      onClick={() => onSelect(s.id)}
    >
      <span className={css.title} data-clip>
        {title}
      </span>
      <span className={css.meta}>
        <span className={css.state} data-state={s.live}>
          <LiveDot state={s.live} />
          {live}
        </span>
        <span className={css.when} data-clip>
          <span className={css.sep}>·</span> {when}
          {figure && (
            <>
              {' '}
              <span className={css.sep}>·</span>{' '}
              <span aria-hidden="true">
                <CompactFigure value={figure} />
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
