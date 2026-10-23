/** Markdown code fences found in text, so code can be shown as code. */

export interface Segment {
  kind: 'prose' | 'code';
  text: string;
  /** The info string after a code fence, e.g. "ts". */
  lang: string | null;
}

/** An opening fence: three or more backticks or tildes, then an info string (its first word). */
const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A closing fence: the same character, at least as many, nothing after. */
const CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * Markdown code fences cut out of text, so code reads as code. As in CommonMark, a backtick
 * fence's info string has no backticks ("```js```" is text) and a closing fence is at least as
 * long as its opening. A fence that never closes is text, not the rest of the message as code.
 * One pass over the lines; text without fences is one prose segment.
 */
export function splitFences(text: string): Segment[] {
  if (!text.includes('```') && !text.includes('~~~')) return [{ kind: 'prose', text, lang: null }];
  const out: Segment[] = [];
  let prose: string[] = [];
  let code: string[] = [];
  let fence: { marks: string; line: string; lang: string | null } | null = null;
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
      const marks = m?.[1] ?? '';
      const info = (m?.[2] ?? '').trim();
      if (m && !(marks.startsWith('`') && info.includes('`'))) {
        pushProse();
        fence = { marks, line, lang: info.split(/\s+/)[0] || null };
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
    } else {
      code.push(line);
    }
  }
  if (fence !== null) prose = [fence.line, ...code, ...prose];
  pushProse();
  return out;
}

/**
 * The segments of `text` to show inline: prose cut to what is left of `budget` characters, each
 * code block whole (it clips itself and copies whole). `cut` says whether anything was left out.
 */
export function clipSegments(text: string, budget: number): { parts: Segment[]; cut: boolean } {
  const parts: Segment[] = [];
  let left = budget;
  let cut = false;
  for (const seg of splitFences(text)) {
    if (left <= 0) {
      cut = true;
      break;
    }
    if (seg.kind === 'prose' && seg.text.length > left) cut = true;
    parts.push(seg.kind === 'code' ? seg : { ...seg, text: seg.text.slice(0, left) });
    left -= seg.text.length;
  }
  return { parts, cut };
}
