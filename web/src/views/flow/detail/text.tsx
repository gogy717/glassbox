import { Check, Copy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LineView } from '../../../components/LineView';
import { Modal } from '../../../components/Modal';
import { useI18n } from '../../../i18n';
import css from './detail.module.css';
import { splitFences } from './read';

/** Characters of one code block shown inline; "show all" opens the rest. */
const CODE_CLIP = 8_000;
/** Characters of one text shown inline, code included. */
const TEXT_CLIP = 6_000;

/** Copies `text()`, built only when clicked: a message's text can be megabytes. */
export function CopyButton({ text, label }: { text: () => string; label?: string }) {
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
    <button type="button" className={css.copy} aria-label={name} title={name} onClick={copy}>
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

/** "Show all (N characters)", opening the whole text as virtualised lines. */
function ShowAll({ label, text }: { label: string; text: string }) {
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

/**
 * Text with its real line breaks; fenced code becomes a code block. Past `TEXT_CLIP` characters
 * the rest is one click away.
 */
export function ReadableText({ text, label }: { text: string; label: string }) {
  const { parts, cut } = useMemo(() => {
    const out: { kind: 'prose' | 'code'; text: string; lang: string | null }[] = [];
    let budget = TEXT_CLIP;
    let cut = false;
    for (const seg of splitFences(text)) {
      if (budget <= 0) {
        cut = true;
        break;
      }
      // A code block keeps its own clip (and copies whole); prose is cut to what is left.
      if (seg.kind === 'prose' && seg.text.length > budget) cut = true;
      out.push(seg.kind === 'code' ? seg : { ...seg, text: seg.text.slice(0, budget) });
      budget -= seg.text.length;
    }
    return { parts: out, cut };
  }, [text]);
  return (
    <div className={css.readableText}>
      {parts.map((p, i) =>
        p.kind === 'code' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one immutable text
          <CodeBlock key={i} text={p.text} lang={p.lang} label={label} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one immutable text
          <p key={i} className={css.prose}>
            {p.text}
          </p>
        ),
      )}
      {cut && <ShowAll label={label} text={text} />}
    </div>
  );
}

/** A small radio group of two or three choices. */
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: { value: V; label: string }[];
  onChange(v: V): void;
}) {
  return (
    <div className={css.segmented} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control, as in the JSON dialog
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
