/**
 * The Files tab's view of the model in `src/shared/files.ts`: which rows a filter shows, and an
 * edit as lines that went and came.
 */
import type { FileRow, FileVerb } from '../../../../src/shared/files.js';

export * from '../../../../src/shared/files.js';

/**
 * The rows to show: with no verb chosen, all of them; else those any chosen verb was tried on
 * (a failed edit was still an edit). `query` must appear in the shown path, case apart.
 */
export function filterFiles(
  rows: FileRow[],
  verbs: ReadonlySet<FileVerb>,
  query: string,
): FileRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (verbs.size === 0 || row.touches.some((t) => verbs.has(t.verb))) &&
      (q === '' || row.path.toLowerCase().includes(q)),
  );
}

// ── Diff ──────────────────────────────────────────────────────────────────────────────────

export interface DiffLine {
  kind: 'same' | 'del' | 'add';
  text: string;
}

/** Past this many lines a side (after the shared head and tail), pairing is not attempted. */
const DIFF_MAX = 1000;

/**
 * The lines of `before` and `after` as one listing: what both have, what went, what came. The
 * shared head and tail are matched first; the rest is paired by its longest common run of
 * lines, so a line moved reads as gone from one place and come at another. Big inputs show as
 * one block out and one in.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: 'same', text }));
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length > DIFF_MAX || midB.length > DIFF_MAX) {
    for (const text of midA) out.push({ kind: 'del', text });
    for (const text of midB) out.push({ kind: 'add', text });
  } else out.push(...pair(midA, midB));
  for (const text of a.slice(a.length - tail)) out.push({ kind: 'same', text });
  return out;
}

/** The middle of a diff by the longest common subsequence of its lines. */
function pair(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the longest common run of a[i..] and b[j..].
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint16Array;
    const next = lcs[i + 1] as Uint16Array;
    for (let j = m - 1; j >= 0; j--)
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] as string });
      i++;
      j++;
    } else if (
      ((lcs[i + 1] as Uint16Array)[j] as number) >= ((lcs[i] as Uint16Array)[j + 1] as number)
    ) {
      out.push({ kind: 'del', text: a[i] as string });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] as string });
      j++;
    }
  }
  for (; i < n; i++) out.push({ kind: 'del', text: a[i] as string });
  for (; j < m; j++) out.push({ kind: 'add', text: b[j] as string });
  return out;
}
