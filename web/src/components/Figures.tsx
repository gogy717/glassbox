/** Runs of digits (with their `,` `.` `:` separators) in a sentence: the parts set as figures. */
const FIGURE = /(\d[\d,.:]*)/;

/**
 * A translated sentence whose numbers are figures ("2 model calls · 2 tools"): each run of
 * digits in the mono face, the words in the UI face, so counts line up like every other number.
 */
export function Figures({ text }: { text: string }) {
  return (
    <>
      {text.split(FIGURE).map((part, i) =>
        // Split with a capture group: odd parts are the matches.
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string
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
