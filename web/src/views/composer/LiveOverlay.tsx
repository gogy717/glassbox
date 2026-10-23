import { Radio } from 'lucide-react';
import type { LivePartial } from '../../../../src/shared/runs.js';
import { useNow } from '../../data/useNow';
import { useI18n } from '../../i18n';
import { formatElapsed } from '../../lib/format';
import css from './Composer.module.css';

/**
 * The reply as it streams from a glassbox-owned run. The transcript only lands once the whole
 * message is done, so this fills the gap; the real request row replaces it afterwards.
 */
export function LiveOverlay({ partial }: { partial: LivePartial | null }) {
  const { t } = useI18n();
  if (!partial) return null;
  return (
    <div className={css.live} role="status" aria-label={t('live.replying')}>
      <div className={css.liveHead}>
        <Radio size={13} aria-hidden="true" className="spin" />
        {t('live.replying')}
      </div>
      <ThinkingLine partial={partial} />
      {partial.thinking && <p className={css.liveThinking}>{partial.thinking}</p>}
      {partial.text && <p className={css.liveText}>{partial.text}</p>}
      {partial.toolUses.map((u) => (
        <p key={u.id} className={css.liveTool}>
          <b>{u.name}</b> {u.inputJson}
        </p>
      ))}
      <span className={css.caret} aria-hidden="true" />
    </div>
  );
}

/**
 * Claude Code streams no thinking text, only a growing token estimate: time and tokens are what
 * show that the model is working and how much. Once the answer streams, the line stays as a
 * record of how long this reply has taken and how much thinking went into it.
 */
function ThinkingLine({ partial }: { partial: LivePartial }) {
  const { t, intl } = useI18n();
  const now = useNow();
  const thinking = !partial.text && partial.toolUses.length === 0;
  const elapsed = formatElapsed(now - Date.parse(partial.startedAt));
  const tokens = partial.thinkingTokens?.toLocaleString(intl);
  let label: string | null;
  if (thinking)
    label =
      tokens === undefined
        ? t('live.thinkingNoTokens', { t: elapsed })
        : t('live.thinking', { t: elapsed, n: tokens });
  else label = tokens === undefined ? null : t('live.answering', { t: elapsed, n: tokens });
  if (!label) return null;
  return <span className={`${css.liveThinkingLine} num`}>{label}</span>;
}
