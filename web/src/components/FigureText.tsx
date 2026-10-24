import { type MessageKey, type Params, useI18n } from '../i18n';

/** Runs of digits (with their `,` `.` `:` separators): the parts set as figures. */
const FIGURE = /(\d[\d,.:]*)/;

/**
 * A translated text whose numbers are figures ("2 model calls · 2 tools", "调用 #1"): each run of
 * digits in the mono face with tabular digits, the words in the UI face, so CJK never goes into
 * the mono face. W4's version (same props) sets the params apart instead; it replaces this one.
 */
export function FigureText({
  k,
  params,
}: {
  k: MessageKey;
  params: Params;
  /** W4's: which params are figures. Here every run of digits is. */
  figures?: readonly string[];
}) {
  const { t } = useI18n();
  return (
    <>
      {t(k, params)
        .split(FIGURE)
        .map((part, i) =>
          // Split with a capture group: odd parts are the matches.
          i % 2 === 1 ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
            <span key={i} className="figure">
              {part}
            </span>
          ) : (
            part
          ),
        )}
    </>
  );
}
