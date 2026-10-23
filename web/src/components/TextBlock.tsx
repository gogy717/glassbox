import { useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { LineView } from './LineView';
import { Modal } from './Modal';
import css from './TextBlock.module.css';

const INLINE_MAX = 20_000;

/** DSH rule: text that starts like JSON and parses is shown pretty-printed. */
function pretty(text: string): string {
  const s = text.trimStart();
  if ((s.startsWith('{') || s.startsWith('[')) && text.length <= 5_000_000) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Not JSON after all.
    }
  }
  return text;
}

interface Props {
  label: string;
  text: string | null | undefined;
}

/** A text field (tool result, response text): capped inline, everything on request. */
export function TextBlock({ label, text }: Props) {
  const { t, intl } = useI18n();
  const [all, setAll] = useState(false);
  const allRef = useRef<HTMLButtonElement>(null);
  const shown = useMemo(() => (text ? pretty(text) : ''), [text]);
  if (!shown) return <p className={css.none}>{t('common.notRecorded')}</p>;
  const cut = shown.length > INLINE_MAX;
  return (
    <div className={css.block}>
      <pre className={css.pre} data-scroll-region>
        {cut ? shown.slice(0, INLINE_MAX) : shown}
      </pre>
      {cut && (
        <button ref={allRef} type="button" className={css.all} onClick={() => setAll(true)}>
          {t('text.showAll', { n: shown.length.toLocaleString(intl) })}
        </button>
      )}
      {all && (
        <Modal label={label} returnFocusTo={allRef} onClose={() => setAll(false)}>
          <LineView text={shown} />
        </Modal>
      )}
    </div>
  );
}
