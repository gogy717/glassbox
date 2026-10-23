import { Fragment } from 'react';
import { type MessageKey, type Params, translateParts, useI18n } from '../i18n';

/**
 * A translated text whose figures (the params named in `figures`, all of them by default) are
 * set in the mono face with tabular digits, and whose words stay in the UI face: "32,070 tokens",
 * "第2轮 · 调用 #1". CJK never goes into the mono face this way.
 */
export function FigureText({
  k,
  params,
  figures,
}: {
  k: MessageKey;
  params: Params;
  figures?: readonly string[];
}) {
  const { locale } = useI18n();
  return (
    <>
      {translateParts(locale, k, params, figures).map((p, i) =>
        typeof p === 'string' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed text
          <Fragment key={i}>{p}</Fragment>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed text
          <span key={i} className="figure">
            {p.value}
          </span>
        ),
      )}
    </>
  );
}
