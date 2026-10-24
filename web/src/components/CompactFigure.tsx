/** From the first CJK character on: a unit ("万", "亿") that `formatCompact` adds in Chinese. */
const CJK_UNIT = /[　-鿿].*$/u;

/**
 * A compact count ("1.9M", "264.8万") as a figure: the digits in the mono face, a CJK unit after
 * them in the UI face, since CJK is never set in mono.
 */
export function CompactFigure({ value, className }: { value: string; className?: string }) {
  const [digits, unit] = splitCompact(value);
  return (
    <>
      <span className={className ? `${className} figure` : 'figure'}>{digits}</span>
      {unit && <span className="figure-unit">{unit}</span>}
    </>
  );
}

const CJK_RUN = /([\u3000-\u9fff\uff00-\uffef]+)/u;

/** `text` with its CJK runs set apart ("≈9万/分钟"): split with a capture, odd parts are CJK. */
const runs = (text: string) => text.split(CJK_RUN);

/** Text that may sit in a mono run ("/分钟", "≈9万/分钟"): its CJK in the UI face. */
export function UiCjk({ text }: { text: string }) {
  return (
    <>
      {runs(text).map((part, i) =>
        i % 2 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <span key={i} className="figure-unit">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** The same in SVG text set in the mono face ("150万", "现在"): CJK runs in the UI face. */
export function SvgUiCjk({ text }: { text: string }) {
  return (
    <>
      {runs(text).map((part, i) =>
        i % 2 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <tspan key={i} fontFamily="var(--font-ui)">
            {part}
          </tspan>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** A compact count as its digits and its CJK unit ("264.8万" → "264.8", "万"; "1.9M" → "1.9M", ""). */
export function splitCompact(value: string): [string, string] {
  const unit = CJK_UNIT.exec(value)?.[0] ?? '';
  return [value.slice(0, value.length - unit.length), unit];
}
