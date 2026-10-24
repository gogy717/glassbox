/** One-line previews for cards: plain text out of markdown, a readable line out of a result. */

/** Far more than a card shows; keeps a huge reply from being scanned whole. */
const READ_MAX = 2_000;

const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const LINE_START = /^\s*(#{1,6}\s+|(>\s?)+|([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?)/;

/** Lines of a markdown table: rows that start with `|`, and the header and body of a `--|--` rule. */
function tableLines(lines: string[]): Set<number> {
  const rows = new Set<number>();
  lines.forEach((line, i) => {
    if (/^\s*\|/.test(line)) rows.add(i);
    if (!TABLE_RULE.test(line)) return;
    rows.add(i - 1);
    for (let j = i + 1; j < lines.length && lines[j]?.includes('|'); j++) rows.add(j);
  });
  return rows;
}

/** A line's inline markdown as words; cell pipes go only in a table, a shell pipe stays. */
function inline(line: string, inTable: boolean): string {
  const words = line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    // Single * or _ only around a word, so 2 * 3 and snake_case stay as they are.
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w_])_(?=[^\s_])([^_]*?[^\s_])_(?![\w_])/g, '$1$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1');
  return inTable ? words.replace(/\|/g, ' ') : words;
}

/** Markdown as the plain words it reads as, on one line: no #, **, `, list markers or links. */
export function plainText(markdown: string): string {
  const lines = markdown.slice(0, READ_MAX).split('\n');
  const table = tableLines(lines);
  return lines
    .map((l, i) =>
      FENCE.test(l) || RULE.test(l) || TABLE_RULE.test(l)
        ? ''
        : inline(l.replace(LINE_START, ''), table.has(i)),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first string value of JSON cut short (which no longer parses), under one of `keys` or
 * under any key.
 */
export function quotedValue(json: string, keys?: string[]): string | null {
  const key = keys ? `"(?:${keys.join('|')})"` : '"(?:[^"\\\\]|\\\\.)*"';
  const m = new RegExp(`${key}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json.slice(0, READ_MAX));
  if (!m?.[1]) return null;
  try {
    return JSON.parse(`"${m[1].replace(/\\$/, '')}"`);
  } catch {
    return m[1];
  }
}
