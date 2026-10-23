/** One-line previews for cards: plain text out of markdown, a readable line out of a result. */

/** Far more than a card shows; keeps a huge reply from being scanned whole. */
const READ_MAX = 2_000;

const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const LINE_START = /^\s*(#{1,6}\s+|(>\s?)+|([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?)/;

function inline(line: string): string {
  return (
    line
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      // Single * or _ only around a word, so 2 * 3 and snake_case stay as they are.
      .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, '$1$2')
      .replace(/(^|[^\w_])_(?=[^\s_])([^_]*?[^\s_])_(?![\w_])/g, '$1$2')
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
      .replace(/\|/g, ' ')
  );
}

/** Markdown as the plain words it reads as, on one line: no #, **, `, list markers or links. */
export function plainText(markdown: string): string {
  return markdown
    .slice(0, READ_MAX)
    .split('\n')
    .filter((l) => !FENCE.test(l) && !RULE.test(l) && !TABLE_RULE.test(l))
    .map((l) => inline(l.replace(LINE_START, '')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The first string in a parsed JSON result, looking into arrays (`[{ type, text }]`). */
function firstString(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = item !== null && typeof item === 'object' ? firstString(item) : null;
      if (s) return s;
    }
    return null;
  }
  if (v === null || typeof v !== 'object') return null;
  const values = Object.entries(v);
  // `[{ "type": "text", "text": "…" }]`: the text, not its type.
  const text = values.find(([k, x]) => k === 'text' && typeof x === 'string');
  const found = text ?? values.find(([, x]) => typeof x === 'string' && x.trim() !== '');
  if (found) return found[1] as string;
  const scalar = values.find(([, x]) => typeof x === 'number' || typeof x === 'boolean');
  return scalar ? `${scalar[0]}: ${scalar[1]}` : null;
}

/** The first string value of JSON cut short, which no longer parses. */
function firstQuotedValue(json: string): string | null {
  const m = /"(?:[^"\\]|\\.)*"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(json.slice(0, READ_MAX));
  if (!m?.[1]) return null;
  try {
    return JSON.parse(`"${m[1].replace(/\\$/, '')}"`);
  } catch {
    return m[1];
  }
}

/** A tool result's first line; a JSON result as its message rather than as JSON. */
export function resultLine(preview: string): string {
  const trimmed = preview.trim();
  if (/^[[{]/.test(trimmed)) {
    let message: string | null;
    try {
      message = firstString(JSON.parse(trimmed));
    } catch {
      message = firstQuotedValue(trimmed);
    }
    if (message) return oneLine(message);
  }
  return oneLine(trimmed.split('\n')[0] ?? '');
}
