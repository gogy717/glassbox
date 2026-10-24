/** From the first CJK character on: a unit ("万", "亿") that `formatCompact` adds in Chinese. */
const CJK_UNIT = /[　-鿿].*$/u;

/**
 * A compact count ("1.9M", "264.8万") as a figure: the digits in the mono face, a CJK unit after
 * them in the UI face, since CJK is never set in mono.
 */
export function CompactFigure({ value, className }: { value: string; className?: string }) {
  const unit = CJK_UNIT.exec(value)?.[0] ?? '';
  return (
    <>
      <span className={className ? `${className} figure` : 'figure'}>
        {value.slice(0, value.length - unit.length)}
      </span>
      {unit}
    </>
  );
}
