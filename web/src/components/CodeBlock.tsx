import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import css from './CodeBlock.module.css';
import { LineView } from './LineView';
import { Modal } from './Modal';

/** Characters of one code block shown inline; "show all" opens the rest. */
export const CODE_CLIP = 8_000;

/** Copies `text()`, built only when clicked: a message's text can be megabytes. */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: () => string;
  label?: string;
  /** Placement in the caller's layout. */
  className?: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1000);
    } catch {
      // Clipboard unavailable (permissions, insecure context): nothing to confirm.
    }
  };
  const name = copied ? t('json.copied') : (label ?? t('json.copy'));
  return (
    <button
      type="button"
      className={className ? `${css.copy} ${className}` : css.copy}
      aria-label={name}
      title={name}
      onClick={copy}
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

/** "Show all (N characters)", opening the whole text as virtualised lines. */
export function ShowAll({ label, text }: { label: string; text: string }) {
  const { t, intl } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button" className={css.showAll} onClick={() => setOpen(true)}>
        {t('text.showAll', { n: text.length.toLocaleString(intl) })}
      </button>
      {open && (
        <Modal label={label} returnFocusTo={ref} onClose={() => setOpen(false)}>
          <LineView text={text} />
        </Modal>
      )}
    </>
  );
}

/** Code (or any verbatim text) with its real line breaks, a copy button, clipped inline. */
export function CodeBlock({
  text,
  lang = null,
  label,
}: {
  text: string;
  lang?: string | null;
  label: string;
}) {
  const { t } = useI18n();
  const cut = text.length > CODE_CLIP;
  return (
    <div className={css.code}>
      {lang ? (
        <div className={css.codeHead}>
          <span className={css.lang}>{lang}</span>
          <CopyButton text={() => text} label={t('detail.copyCode')} />
        </div>
      ) : (
        <span className={css.codeCopy}>
          <CopyButton text={() => text} label={t('detail.copyCode')} />
        </span>
      )}
      <pre className={css.codePre} data-scroll-region>
        {cut ? text.slice(0, CODE_CLIP) : text}
      </pre>
      {cut && <ShowAll label={label} text={text} />}
    </div>
  );
}
