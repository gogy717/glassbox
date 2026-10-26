import { TriangleAlert, X } from 'lucide-react';
import type { SessionActivity, SessionSummary, TroubleSignal } from '../../../src/core/model.js';
import { type MessageKey, type Params, translateParts, useI18n } from '../i18n';
import { isRunning } from '../lib/sessions';
import { toolCategory } from '../lib/tool-category';
import { troublePhrase } from '../lib/trouble';
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
 * A phrase with its target (a file, a pattern, a host, a command's summary) in the mono face,
 * its other params in its words. Its words keep their spaces, for the row's name; on screen the
 * line's gap spaces them. The target is what gives way in a narrow row (`data-gives-way`),
 * never the verb.
 */
function Phrase({ k, x, params }: { k: MessageKey; x?: string; params?: Params }) {
  const { locale } = useI18n();
  const all = x === undefined ? { ...params } : { ...params, x };
  return (
    <>
      {translateParts(locale, k, all, ['x']).map((p, i) =>
        typeof p === 'string' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <span key={i}>{p}</span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <span key={i} className={css.target} data-gives-way>
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
 * What a waiting session waits for, and what about when its activity says: "Permission · Bash ·
 * git push +1", "Question", "Your turn", in a row as on Home's board, which adds how long
 * ("… · 0:20") under a heading that already says it waits for you.
 */
function Waiting({ session: s, clock }: { session: SessionSummary; clock: boolean }) {
  const { t } = useI18n();
  const kind = waitKind(s.activity);
  const since = waitingSince(s);
  const target = kind === 'turn' ? null : (s.activity?.target ?? null);
  return (
    <>
      {kind === 'permission' ? (
        <Phrase k={WAIT_KEY.permission} x={s.activity?.tool ?? ''} />
      ) : (
        <span>{t(WAIT_KEY[kind])}</span>
      )}
      {target && (
        <>
          <span className={css.sep}> · </span>
          <span className={css.target} data-gives-way>
            <UiCjk text={target} />
          </span>
        </>
      )}
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
 * A running session's strongest sign of trouble, short, in the error tone: "Retrying npm test ·
 * 4×", "Waiting 14 min". The call it names in the mono face, as an activity's target.
 */
export function TroubleLine({ signal, now }: { signal: TroubleSignal; now: number }) {
  const { t } = useI18n();
  const { k, params } = troublePhrase(t, signal, now, 'short');
  const { x, ...rest } = params;
  return (
    <span className={css.trouble} data-trouble={signal.kind}>
      <TriangleAlert size={12} strokeWidth={2.5} className={css.glyph} aria-hidden="true" />
      <Phrase k={k} x={x === undefined ? undefined : String(x)} params={rest} />
    </span>
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
 * ("Reading tokens.css · 0:04", "Thinking · 1:12"), else its live word; what a waiting session
 * waits for ("Permission · Bash", with its clock on a card); Idle for one open in a terminal with
 * nothing pending; Failed, with the reason, when its glassbox run failed. Targets and clocks are
 * in the mono face; each clock re-renders on its own, every second, and nothing else does.
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
            <span className={css.reason} data-gives-way>
              {failure}
            </span>
          </>
        )}
      </span>
    );
  return (
    <span className={css.activity} data-state={s.live}>
      <LiveDot state={s.live} />
      {s.live === 'waiting' ? (
        <Waiting session={s} clock={card} />
      ) : s.live === 'busy' && s.activity ? (
        <Doing a={s.activity} clock={card} />
      ) : s.live === 'idle' ? (
        <span title={t('live.idleHint')}>{t('live.idle')}</span>
      ) : (
        <span>{t(`live.${s.live}`)}</span>
      )}
    </span>
  );
}
