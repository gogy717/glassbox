import { X } from 'lucide-react';
import type { SessionActivity, SessionSummary } from '../../../src/core/model.js';
import { type MessageKey, translateParts, useI18n } from '../i18n';
import { isRunning } from '../lib/sessions';
import { toolCategory } from '../lib/tool-category';
import { WAIT_KEY, waitingSince, waitKind } from '../lib/waiting';
import css from './ActivityLine.module.css';
import { UiCjk } from './CompactFigure';
import { LiveDot, Ticking } from './Status';

/** Tools that look for files or text rather than open one. */
const SEARCH = /grep|glob|search|find/i;

/** A running tool's phrase, by what the tool does; `{x}` is its target. */
export function toolPhrase(tool: string): MessageKey {
  switch (toolCategory(tool)) {
    case 'explore':
      return SEARCH.test(tool) ? 'activity.searching' : 'activity.reading';
    case 'edit':
      return 'activity.editing';
    case 'run':
    case 'git':
      return 'activity.running';
    case 'web':
      return SEARCH.test(tool) ? 'activity.searching' : 'activity.fetching';
    case 'delegate':
      return 'activity.delegating';
    case 'plan':
      return 'activity.planning';
    case 'ask':
      return 'activity.asking';
    default:
      return 'activity.using';
  }
}

/**
 * A phrase with its target (a file, a pattern, a host, a command's summary) in the mono face.
 * Its words keep their spaces, for the row's name; on screen the line's gap spaces them.
 */
function Phrase({ k, x }: { k: MessageKey; x: string }) {
  const { locale } = useI18n();
  return (
    <>
      {translateParts(locale, k, { x }).map((p, i) =>
        typeof p === 'string' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <span key={i}>{p}</span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <span key={i} className={css.target}>
            <UiCjk text={p.value} />
          </span>
        ),
      )}
    </>
  );
}

/** What a busy session is doing, with its clock where the density shows one. */
function Doing({ a, clock }: { a: SessionActivity; clock: boolean }) {
  const { t } = useI18n();
  const since = a.since;
  if (a.kind === 'thinking')
    return since ? (
      <Ticking since={since} labelKey="live.thinkingNoTokens" />
    ) : (
      <span>{t('activity.thinking')}</span>
    );
  if (a.kind === 'writing')
    return since ? (
      <Ticking since={since} labelKey="activity.writing" />
    ) : (
      <span>{t('activity.replying')}</span>
    );
  if (a.kind !== 'tool' || a.tool === null) return <span>{t('live.busy')}</span>;
  // A phrase about a target needs one: without it, the tool by name.
  const key = toolPhrase(a.tool);
  const bare = key === 'activity.planning' || key === 'activity.asking';
  return (
    <>
      <Phrase k={bare || a.target !== null ? key : 'activity.using'} x={a.target ?? a.tool} />
      {clock && since && (
        <>
          <span className={css.sep}> · </span>
          <Ticking since={since} labelKey="activity.elapsed" />
        </>
      )}
    </>
  );
}

/**
 * What a waiting session waits for, and for how long: "Permission · Bash · 0:20", "Question ·
 * 1:02", "Your turn · 3:40". On a card, under a heading that already says it waits for you.
 */
function Waiting({ session: s }: { session: SessionSummary }) {
  const { t } = useI18n();
  const kind = waitKind(s.activity);
  const since = waitingSince(s);
  return (
    <>
      {kind === 'permission' ? (
        <Phrase k={WAIT_KEY.permission} x={s.activity?.tool ?? ''} />
      ) : (
        <span>{t(WAIT_KEY[kind])}</span>
      )}
      {since && (
        <>
          <span className={css.sep}> · </span>
          <Ticking since={since} labelKey="activity.elapsed" />
        </>
      )}
    </>
  );
}

interface Props {
  session: SessionSummary;
  /** Set when the session's glassbox run failed: its error, or null when it gave none. */
  failure?: string | null;
  /** A card shows every clock and a failure's reason; a compact row keeps to the phrase. */
  density: 'compact' | 'card';
}

/**
 * A session's state as its row says it: what it is doing right now when the server knows
 * ("Reading tokens.css · 0:04", "Thinking · 1:12"), else its live word; on a card, what a
 * waiting session waits for ("Permission · Bash · 0:20"); Failed, with the reason, when its
 * glassbox run failed. Targets and clocks are in the mono face; each clock re-renders on its
 * own, every second, and nothing else does.
 */
export function ActivityLine({ session: s, failure, density }: Props) {
  const { t } = useI18n();
  const card = density === 'card';
  const running = isRunning(s);
  if (failure !== undefined && !running)
    return (
      <span className={css.activity} data-state="failed">
        <X size={12} strokeWidth={2.5} className={css.glyph} aria-hidden="true" />
        <span className={css.word}>{t('status.error')}</span>
        {card && failure && (
          <>
            <span className={css.sep}> · </span>
            <span className={css.reason}>{failure}</span>
          </>
        )}
      </span>
    );
  return (
    <span className={css.activity} data-state={s.live}>
      <LiveDot state={s.live} />
      {s.live === 'waiting' ? (
        card ? (
          <Waiting session={s} />
        ) : (
          <span>{t('live.waiting')}</span>
        )
      ) : s.live === 'busy' && s.activity ? (
        <Doing a={s.activity} clock={card} />
      ) : (
        <span>{t(`live.${s.live}`)}</span>
      )}
    </span>
  );
}
