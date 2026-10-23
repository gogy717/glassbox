/** Markdown code fences found in text, so code can be shown as code. */

export interface Segment {
  kind: 'prose' | 'code';
  text: string;
  /** The info string after a code fence, e.g. "ts". */
  lang: string | null;
}

/** An opening fence: up to three spaces, three or more backticks or tildes, an info string. */
const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
/** A closing fence: the same character, at least as many, nothing after. */
const CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * Markdown code fences cut out of text, so code reads as code. As in CommonMark:
 * - a backtick fence's info string has no backticks ("```js```" is text);
 * - a closing fence is at least as long as its opening;
 * - the opening fence's indentation is taken off each code line, so code inside a list item
 *   reads (and copies) without the list's indent.
 * A fence that never closes is text, not the rest of the message as code. `maxIndent` limits
 * which fences are cut out: 0 keeps fences inside list items (indented) as text for a markdown
 * renderer, which nests them where they belong. One pass over the lines.
 */
export function splitFences(text: string, maxIndent = 3): Segment[] {
  if (!text.includes('```') && !text.includes('~~~')) return [{ kind: 'prose', text, lang: null }];
  const out: Segment[] = [];
  let prose: string[] = [];
  let code: string[] = [];
  /** The code lines as written, should the fence never close. */
  let raw: string[] = [];
  let fence: { indent: number; marks: string; line: string; lang: string | null } | null = null;
  const pushProse = () => {
    if (prose.some((l) => l.trim() !== '')) {
      const last = out.at(-1);
      // Prose next to prose (an unclosed fence's lines) is one segment.
      if (last?.kind === 'prose') last.text += `\n${prose.join('\n')}`;
      else out.push({ kind: 'prose', text: prose.join('\n'), lang: null });
    }
    prose = [];
  };
  for (const line of text.split('\n')) {
    if (fence === null) {
      const m = OPEN.exec(line);
      const indent = m?.[1]?.length ?? 0;
      const marks = m?.[2] ?? '';
      const info = (m?.[3] ?? '').trim();
      if (m && indent <= maxIndent && !(marks.startsWith('`') && info.includes('`'))) {
        pushProse();
        fence = { indent, marks, line, lang: info.split(/\s+/)[0] || null };
      } else {
        prose.push(line);
      }
      continue;
    }
    const close = CLOSE.exec(line);
    const marks = close?.[1] ?? '';
    if (close && marks[0] === fence.marks[0] && marks.length >= fence.marks.length) {
      out.push({ kind: 'code', text: code.join('\n'), lang: fence.lang });
      fence = null;
      code = [];
      raw = [];
    } else {
      // Up to the fence's own indentation comes off; deeper indentation is the code's.
      const lead = /^ */.exec(line)?.[0].length ?? 0;
      code.push(line.slice(Math.min(lead, fence.indent)));
      raw.push(line);
    }
  }
  if (fence !== null) prose = [fence.line, ...raw];
  pushProse();
  return out;
}

export interface ClipLimits {
  /** Characters of prose shown. */
  prose: number;
  /** Characters of code shown, each block counted as much as it shows (`codeClip` at most). */
  code: number;
  /** What one code block shows inline (it clips itself and copies whole). */
  codeClip: number;
  /** Which fences to cut out (see `splitFences`). */
  maxIndent?: number;
}

/**
 * `text` cut to `max` characters at the last line break before it, so a link, a table row or a
 * character outside the BMP is never split; at `max` itself when there is no line break.
 */
function cutAt(text: string, max: number): string {
  const nl = text.lastIndexOf('\n', max);
  if (nl > 0) return text.slice(0, nl);
  const code = text.charCodeAt(max - 1);
  // A high surrogate left alone would show as a broken character.
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * The segments of `text` to show inline, in order until the first cut: prose up to its budget,
 * cut at a line break; each code block whole, counted against a budget of its own, so a long
 * block does not hide the prose after it. `cut` says whether anything was left out.
 */
export function clipSegments(text: string, limits: ClipLimits): { parts: Segment[]; cut: boolean } {
  const parts: Segment[] = [];
  let prose = limits.prose;
  let code = limits.code;
  for (const seg of splitFences(text, limits.maxIndent)) {
    if (seg.kind === 'code') {
      if (code <= 0) return { parts, cut: true };
      parts.push(seg);
      code -= Math.min(seg.text.length, limits.codeClip);
    } else if (seg.text.length > prose) {
      if (prose > 0) parts.push({ ...seg, text: cutAt(seg.text, prose) });
      return { parts, cut: true };
    } else {
      parts.push(seg);
      prose -= seg.text.length;
    }
  }
  return { parts, cut: false };
}
