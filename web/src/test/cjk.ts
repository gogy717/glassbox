/** CJK set in the mono face: never (D1). Text in a `.figure` run, or SVG text whose font is mono. */
const CJK = /[　-鿿＀-￯]/;

export function cjkInMono(root: ParentNode): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll('*')) {
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? '')
      .join('');
    if (!CJK.test(own)) continue;
    const html = el.closest('.figure') && !el.closest('.figure-unit');
    const font = el.closest('[font-family]')?.getAttribute('font-family') ?? '';
    if (html || /mono/.test(font)) out.push(own.trim());
  }
  return out;
}
