import { useMemo } from 'react';
import { CODE_CLIP, CodeBlock, ShowAll } from '../../../components/CodeBlock';
import { clipSegments } from '../../../lib/fences';
import css from './detail.module.css';

/** Characters of one text shown inline, code included. */
const TEXT_CLIP = 6_000;

/**
 * Text with its real line breaks; fenced code becomes a code block. Past `TEXT_CLIP` characters
 * the rest is one click away.
 */
export function ReadableText({ text, label }: { text: string; label: string }) {
  const { parts, cut } = useMemo(
    () => clipSegments(text, { prose: TEXT_CLIP, code: 4 * CODE_CLIP, codeClip: CODE_CLIP }),
    [text],
  );
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
