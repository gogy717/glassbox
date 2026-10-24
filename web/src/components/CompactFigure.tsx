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
      {unit}
    </>
  );
}

/** A compact count as its digits and its CJK unit ("264.8万" → "264.8", "万"; "1.9M" → "1.9M", ""). */
export function splitCompact(value: string): [string, string] {
  const unit = CJK_UNIT.exec(value)?.[0] ?? '';
  return [value.slice(0, value.length - unit.length), unit];
}
