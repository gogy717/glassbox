import { useMemo } from 'react';
import { CodeBlock, ShowAll } from '../../../components/CodeBlock';
import { clipSegments } from '../../../lib/fences';
import css from './detail.module.css';

/** Characters of one text shown inline, code included. */
const TEXT_CLIP = 6_000;

/**
 * Text with its real line breaks; fenced code becomes a code block. Past `TEXT_CLIP` characters
 * the rest is one click away.
 */
export function ReadableText({ text, label }: { text: string; label: string }) {
  const { parts, cut } = useMemo(() => clipSegments(text, TEXT_CLIP), [text]);
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
