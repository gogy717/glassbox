import { Hourglass } from 'lucide-react';
import type { LivePartial } from '../../../../src/shared/runs.js';
import { FigureText } from '../../components/FigureText';
import { useNow } from '../../data/useNow';
import { type MessageKey, useI18n } from '../../i18n';
import { formatElapsed } from '../../lib/format';
import css from './Composer.module.css';

/**
 * The reply as it streams from a glassbox-owned run. The transcript only lands once the whole
 * message is done, so this fills the gap; the real request row replaces it afterwards. A
 * bordered panel (no dashes, no tint): "Replying live" in the accent with its timing beside it,
 * then the text so far in mono with a caret.
 */
export function LiveOverlay({ partial }: { partial: LivePartial | null }) {
  const { t } = useI18n();
  if (!partial) return null;
  const caret = <span className={css.caret} aria-hidden="true" />;
  return (
    <div className={css.live} role="status" aria-label={t('live.replying')}>
      <div className={css.liveHead}>
        <Hourglass size={12} aria-hidden="true" />
        {t('live.replying')}
        <ThinkingLine partial={partial} />
      </div>
      {partial.thinking && <p className={css.liveThinking}>{partial.thinking}</p>}
      {partial.text && (
        <p className={css.liveText}>
          {partial.text}
          {partial.toolUses.length === 0 && caret}
        </p>
      )}
      {partial.toolUses.map((u, i) => (
        <p key={u.id} className={css.liveTool}>
          <b>{u.name}</b> {u.inputJson}
          {i === partial.toolUses.length - 1 && caret}
        </p>
      ))}
      {/* The caret ends the last line streamed; alone, until anything streams. */}
      {!partial.text && partial.toolUses.length === 0 && caret}
    </div>
  );
}

/**
 * Claude Code streams no thinking text, only a growing token estimate: time and tokens are what
 * show that the model is working and how much. Once the answer streams, the line stays as a
 * record of how long this reply has taken and how much thinking went into it.
 */
function ThinkingLine({ partial }: { partial: LivePartial }) {
  const { intl } = useI18n();
  const now = useNow();
  const thinking = !partial.text && partial.toolUses.length === 0;
  const elapsed = formatElapsed(now - Date.parse(partial.startedAt));
  const tokens = partial.thinkingTokens?.toLocaleString(intl);
  const key: MessageKey | null = thinking
    ? tokens === undefined
      ? 'live.thinkingNoTokens'
      : 'live.thinking'
    : tokens === undefined
      ? null
      : 'live.answering';
  if (!key) return null;
  // The figures (time, tokens) mono and tabular; the words, and CJK in zh, in the UI face.
  return (
    <span className={css.liveMeta}>
      <FigureText k={key} params={{ t: elapsed, n: tokens ?? '' }} figures={['t', 'n']} />
    </span>
  );
}
