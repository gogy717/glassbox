import { Fragment, type ReactNode } from 'react';
import { KEYMAP, type KeyRow, keyLabel } from '../data/shortcuts';
import { useI18n } from '../i18n';
import { Modal } from './Modal';
import css from './ShortcutsHelp.module.css';

const kbd = (key: string) => (
  <kbd key={key} className={css.kbd}>
    {keyLabel(key)}
  </kbd>
);

/**
 * A line's keys as one writes them: a run of them as its ends ("1–5"), two alternatives with a
 * slash ("j / k"), a pair in the order pressed ("g h").
 */
function keysOf(row: KeyRow): ReactNode {
  const { bindings } = row;
  const first = bindings[0]?.keys ?? [];
  const last = bindings.at(-1)?.keys ?? [];
  if (bindings.length > 2) return [kbd(first[0] ?? ''), '–', kbd(last[0] ?? '')];
  if (bindings.length === 2) return [kbd(first[0] ?? ''), ' / ', kbd(last[0] ?? '')];
  return first.map((k, i) => (
    <Fragment key={k}>
      {i > 0 && ' '}
      {kbd(k)}
    </Fragment>
  ));
}

/** The ? overlay: every keyboard shortcut, as the key map has them, and what each does. */
export function ShortcutsHelp({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  return (
    <Modal label={t('keys.title')} size="compact" onClose={onClose}>
      <dl className={css.list}>
        {KEYMAP.map((row) => (
          <div key={row.label} className={css.row}>
            <dt className={css.keys}>{keysOf(row)}</dt>
            <dd className={css.what}>{t(row.label)}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
