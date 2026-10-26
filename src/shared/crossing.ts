/**
 * Crossing: the files more than one working tree of a repository changed, which only merge time
 * finds otherwise. From each session's changes of files (the Files model's edits, creations and
 * deletions, `touchesOf`), with the lines a change made when the agent recorded them
 * (`ToolCall.lineChanges`), grouped by the repository its directory belongs to
 * (`SessionSummary.repo`, `WeekSession.repo`). A path crosses when two or more different working
 * trees changed it; the sessions of one tree are that branch's own history. Pure: no file is read.
 */
import type { LineChange, RepoIdentity, ToolCall } from '../core/model.js';
import { type RawTouch, resolvePath, touchesOf } from './files.js';

/** What a change did to a file. */
export type ChangeVerb = 'edited' | 'created' | 'deleted';
const CHANGED: ReadonlySet<string> = new Set(['edited', 'created', 'deleted']);

/**
 * One change of a path: when (epoch ms: its call's end, else its start), and the lines it changed
 * in the file as it found it: `LineChange`s, 'all' for the whole file (created, deleted, written
 * whole), null when they are not known.
 */
export type EditMark = [at: number, lines: LineChange[] | 'all' | null];

/** A session's changes of one path (inside a window, for the week). */
export interface PathOps {
  /** As the Files tab resolves it: absolute when the session's directory is known. */
  path: string;
  edited: number;
  created: number;
  deleted: number;
  /** Its first and last change (epoch ms). */
  first: number;
  last: number;
  /** In time order, at most `MAX_MARKS`; then one more, null-lined, when changes were left out. */
  marks: EditMark[];
}

/** A session's changes of files, path by path: `WeekFigures.files`. */
export interface FileOps {
  /** The most recently changed first, at most `MAX_PATHS`. */
  paths: PathOps[];
  /** Paths it changed beyond those, left out. */
  more: number;
}

/** Paths a session's files keep (the most recently changed), so the week's JSON stays small. */
export const MAX_PATHS = 400;
/** Changes of a path whose lines are kept; past them, its lines are not known. */
export const MAX_MARKS = 64;

export interface FileChange {
  path: string;
  verb: ChangeVerb;
  mark: EditMark;
}

const ms = (iso: string | null) => (iso === null ? Number.NaN : Date.parse(iso));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A change's lines: a file made or removed is all of it; an edit's, as its agent recorded them. */
function linesOf(touch: RawTouch, tool: ToolCall): EditMark[1] {
  if (touch.verb !== 'edited') return 'all';
  switch (touch.detail.kind) {
    // Written whole over the file: what it changed when recorded, else all of it.
    case 'write':
      return tool.lineChanges ?? 'all';
    case 'replace':
    case 'none':
      return tool.lineChanges ?? null;
    // A patch's section (Codex's hunks carry no line numbers), a notebook's cell.
    default:
      return null;
  }
}

/**
 * The files one call changed, by path resolved against `cwd`: nothing for a call that failed or
 * is still running (neither is known to have changed anything), nor for one that only read.
 * `fallback` times a call that has no time of its own.
 */
export function changesOf(tool: ToolCall, cwd: string | null, fallback: number): FileChange[] {
  if (tool.status === 'error' || tool.status === 'running') return [];
  const end = ms(tool.endedAt);
  const start = ms(tool.startedAt);
  const at = Number.isFinite(end) ? end : Number.isFinite(start) ? start : fallback;
  const out: FileChange[] = [];
  for (const touch of touchesOf(tool)) {
    if (!CHANGED.has(touch.verb)) continue;
    const path = resolvePath(touch.path, cwd);
    if (path === cwd) continue;
    out.push({ path, verb: touch.verb as ChangeVerb, mark: [at, linesOf(touch, tool)] });
  }
  return out;
}

/** Adds one change to the paths it is counted under. */
export function addChange(byPath: Map<string, PathOps>, c: FileChange): void {
  const at = c.mark[0];
  let p = byPath.get(c.path);
  if (!p) {
    p = { path: c.path, edited: 0, created: 0, deleted: 0, first: at, last: at, marks: [] };
    byPath.set(c.path, p);
  }
  p[c.verb]++;
  if (at < p.first) p.first = at;
  if (at > p.last) p.last = at;
  p.marks.push(c.mark);
}

/** Adds the changes of `from` (another hour's, another slice's) into `into`, `from` untouched. */
export function mergePathOps(into: Map<string, PathOps>, from: Iterable<PathOps>): void {
  for (const o of from) {
    const p = into.get(o.path);
    if (!p) {
      into.set(o.path, { ...o, marks: [...o.marks] });
      continue;
    }
    p.edited += o.edited;
    p.created += o.created;
    p.deleted += o.deleted;
    p.first = Math.min(p.first, o.first);
    p.last = Math.max(p.last, o.last);
    p.marks.push(...o.marks);
  }
}

/**
 * The paths as a session's files: the most recently changed `MAX_PATHS`, each its marks in time
 * order and at most `MAX_MARKS` of them. Undefined when nothing changed. `byPath` is not touched.
 */
export function fileOps(byPath: ReadonlyMap<string, PathOps>): FileOps | undefined {
  if (byPath.size === 0) return undefined;
  const all = [...byPath.values()].sort((a, b) => b.last - a.last || cmp(a.path, b.path));
  const paths = all.slice(0, MAX_PATHS).map((p) => {
    const marks = [...p.marks].sort((a, b) => a[0] - b[0]);
    const over = marks[MAX_MARKS];
    // Past the limit, one mark says the rest happened, their lines not kept.
    return {
      ...p,
      marks: over ? [...marks.slice(0, MAX_MARKS), [over[0], null] as EditMark] : marks,
    };
  });
  return { paths, more: all.length - paths.length };
}

/** What the given agents' calls changed in files (a session's, from its snapshot). */
export function fileOpsOf(
  tools: Iterable<ToolCall>,
  cwd: string | null,
  agentIds: ReadonlySet<string>,
  fallback: number,
): FileOps | undefined {
  const byPath = new Map<string, PathOps>();
  for (const tool of tools) {
    if (!agentIds.has(tool.agentId)) continue;
    for (const c of changesOf(tool, cwd, fallback)) addChange(byPath, c);
  }
  return fileOps(byPath);
}

// ── Lines, as a tree found the file ──────────────────────────────────────────────────────

/**
 * A run of the file's lines as it was when the tree's first change came: from `from` to `to`
 * (1-based), or, with `to` one less than `from`, the place before line `from` lines went in.
 */
type Span = [from: number, to: number];

/** Two runs a merge would find in conflict: they share a line or lie side by side (as git's). */
const meets = (a: Span, b: Span) => a[0] <= b[1] + 1 && b[0] <= a[1] + 1;

/**
 * The tree's file now, as runs of its lines from the file it found: each run's first line now
 * (`start`, 1-based) and length (the last runs on forever), the line it was then (`base`), or,
 * for lines the tree put in itself, null and the place they went in (`anchor`).
 */
interface Seg {
  start: number;
  len: number;
  base: number | null;
  anchor: number;
}

const segAt = (segs: Seg[], line: number) =>
  segs.find((s) => line < s.start + s.len) ?? (segs.at(-1) as Seg);

/** Where line `line` of the file now was in the file found: its own line, or its run's place. */
function foundAt(segs: Seg[], line: number, last: boolean): number {
  const s = segAt(segs, line);
  if (s.base !== null) return s.base + (line - s.start);
  return last ? s.anchor - 1 : s.anchor;
}

/** The part of `s` from line `from` up to `to` (not included). */
const cut = (s: Seg, from: number, to: number): Seg => ({
  start: from,
  len: to - from,
  base: s.base === null ? null : s.base + (from - s.start),
  anchor: s.anchor,
});

/** The file after `removed` lines at `at` gave way to `added` new ones (placed at `anchor`). */
function splice(segs: Seg[], at: number, removed: number, added: number, anchor: number): Seg[] {
  const end = at + removed;
  const before: Seg[] = [];
  const after: Seg[] = [];
  for (const s of segs) {
    const sEnd = s.start + s.len;
    if (s.start < at) before.push(cut(s, s.start, Math.min(sEnd, at)));
    if (sEnd > end) {
      const rest = cut(s, Math.max(s.start, end), sEnd);
      after.push({ ...rest, start: rest.start + added - removed });
    }
  }
  const made: Seg[] = added > 0 ? [{ start: at, len: added, base: null, anchor }] : [];
  return [...before, ...made, ...after];
}

/**
 * A tree's changes of a path, in time order, as runs of the file the tree found: each change
 * placed back through the tree's earlier ones. A change whose lines are not known stops that
 * (the lines after it cannot be placed); one of the whole file makes the whole file.
 */
function asFound(marks: readonly EditMark[]): { all: boolean; spans: Span[]; known: boolean } {
  let segs: Seg[] = [{ start: 1, len: Number.POSITIVE_INFINITY, base: 1, anchor: 1 }];
  const spans: Span[] = [];
  let known = true;
  for (const [, lines] of marks) {
    if (lines === 'all') return { all: true, spans: [], known: true };
    if (lines === null) known = false;
    if (lines === null || !known) continue;
    // One call's runs are in the file it found: the last first, so the earlier keep their lines.
    for (const [rawAt, removed, added] of [...lines].sort((a, b) => b[0] - a[0])) {
      const at = Math.max(1, rawAt);
      const from = foundAt(segs, at, false);
      const to = removed > 0 ? foundAt(segs, at + removed - 1, true) : from - 1;
      spans.push([from, Math.max(to, from - 1)]);
      segs = splice(segs, at, removed, added, from);
    }
  }
  return { all: false, spans, known };
}

/** Runs in order, those that meet joined. */
function joined(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = out.at(-1);
    if (last && meets(last, s)) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

// ── Crossings ─────────────────────────────────────────────────────────────────────────────

/** A session as crossings read it: its repository, and its changes of files in the window. */
export interface CrossingSession {
  id: string;
  repo?: RepoIdentity | null;
  files?: FileOps;
}

/** A working tree of a repository with sessions in the window. */
export interface TreeRef {
  dir: string;
  /** The directory's last segment: the repository's name for the main one. */
  name: string;
  /** The repository's main working tree. */
  main: boolean;
  sessions: number;
}

/**
 * Lines `from` to `to` of the file as the tree found it (1-based); with `to` one less than
 * `from`, the place before line `from` where lines went in.
 */
export interface LineSpan {
  from: number;
  to: number;
  /** Another tree changed the same lines, or lines beside them. */
  hot: boolean;
}

/** One tree's changes of a crossing path. */
export interface TreeSide {
  tree: TreeRef;
  /** Its sessions that changed the path, the earliest first, each with the path as it named it. */
  sessions: { id: string; path: string }[];
  edits: number;
  first: number;
  last: number;
  /** The lines it changed, in the file as it found it: runs in order, or the whole file. */
  lines: 'all' | LineSpan[];
  /** Whether the lines of each of its changes are known (else `lines` holds those that are). */
  known: boolean;
  /** Its lines meet another tree's. */
  hot: boolean;
}

export interface CrossingPath {
  /** Relative to the working trees, with "/". */
  path: string;
  /** One side per tree that changed it, two or more, in the trees' order. */
  sides: TreeSide[];
  /** Whether two trees changed the same or neighbouring lines; null when that is not known. */
  overlap: boolean | null;
  /** Its latest change. */
  last: number;
}

export interface RepoCrossing {
  root: string;
  /** The repository's name: its main tree's directory name. */
  name: string;
  /** Its working trees with sessions in the window: the main one first, then by name. */
  trees: TreeRef[];
  /** Same lines first, then not known, then apart; the latest first. */
  paths: CrossingPath[];
  /** Its sessions whose files were cut at `MAX_PATHS`: a crossing may be among those left out. */
  cut: number;
}

/** A directory's segments, whichever separator, without empties. */
const segments = (p: string) => p.split(/[\\/]+/).filter(Boolean);

interface SideAcc {
  sessions: { id: string; path: string; first: number }[];
  edits: number;
  first: number;
  last: number;
  marks: EditMark[];
}

interface TreeAcc {
  ref: TreeRef;
  paths: Map<string, SideAcc>;
}

const RANK = (o: boolean | null) => (o === true ? 0 : o === null ? 1 : 2);

/** A path two or more trees changed: each tree's lines, and where they meet. */
function crossingPath(path: string, list: { tree: TreeAcc; side: SideAcc }[]): CrossingPath {
  const found = list.map(({ side }) => {
    const f = asFound([...side.marks].sort((a, b) => a[0] - b[0]));
    return { ...f, spans: joined(f.spans) };
  });
  const sides: TreeSide[] = list.map(({ tree, side }, i) => {
    const mine = found[i] as (typeof found)[number];
    const others = found.filter((_, j) => j !== i);
    const lines: TreeSide['lines'] = mine.all
      ? 'all'
      : mine.spans.map(([from, to]) => ({
          from,
          to,
          hot: others.some((o) => o.all || o.spans.some((t) => meets([from, to], t))),
        }));
    return {
      tree: tree.ref,
      sessions: [...side.sessions]
        .sort((a, b) => a.first - b.first)
        .map(({ id, path: p }) => ({ id, path: p })),
      edits: side.edits,
      first: side.first,
      last: side.last,
      lines,
      known: mine.known,
      hot: mine.all || others.some((o) => o.all) || (lines !== 'all' && lines.some((s) => s.hot)),
    };
  });
  const overlap = sides.some((s) => s.hot) ? true : sides.every((s) => s.known) ? false : null;
  return { path, sides, overlap, last: Math.max(...sides.map((s) => s.last)) };
}

/**
 * The repositories with sessions in two or more working trees, and the paths two or more of
 * those trees changed. A path compares relative to each session's own tree; one outside it is
 * not that tree's change. Sessions without a repository are left out.
 */
export function crossings(sessions: readonly CrossingSession[]): RepoCrossing[] {
  const repos = new Map<
    string,
    { root: string; name: string; trees: Map<string, TreeAcc>; cut: number }
  >();
  for (const s of sessions) {
    if (!s.repo) continue;
    const rootKey = segments(s.repo.root).join('/');
    const dirSegs = segments(s.repo.dir);
    const dirKey = dirSegs.join('/');
    let repo = repos.get(rootKey);
    if (!repo) {
      repo = { root: s.repo.root, name: s.repo.name, trees: new Map(), cut: 0 };
      repos.set(rootKey, repo);
    }
    let tree = repo.trees.get(dirKey);
    if (!tree) {
      const ref = {
        dir: s.repo.dir,
        name: dirSegs.at(-1) ?? s.repo.name,
        main: dirKey === rootKey,
        sessions: 0,
      };
      tree = { ref, paths: new Map() };
      repo.trees.set(dirKey, tree);
    }
    tree.ref.sessions++;
    if (!s.files) continue;
    if (s.files.more > 0) repo.cut++;
    for (const p of s.files.paths) {
      const segs = segments(p.path);
      if (segs.length <= dirSegs.length || dirSegs.some((d, i) => segs[i] !== d)) continue;
      const rel = segs.slice(dirSegs.length).join('/');
      let side = tree.paths.get(rel);
      if (!side) {
        side = { sessions: [], edits: 0, first: p.first, last: p.last, marks: [] };
        tree.paths.set(rel, side);
      }
      side.sessions.push({ id: s.id, path: p.path, first: p.first });
      side.edits += p.edited + p.created + p.deleted;
      side.first = Math.min(side.first, p.first);
      side.last = Math.max(side.last, p.last);
      side.marks.push(...p.marks);
    }
  }
  const out: RepoCrossing[] = [];
  for (const repo of repos.values()) {
    if (repo.trees.size < 2) continue;
    const trees = [...repo.trees.values()].sort(
      (a, b) => Number(b.ref.main) - Number(a.ref.main) || cmp(a.ref.name, b.ref.name),
    );
    const byPath = new Map<string, { tree: TreeAcc; side: SideAcc }[]>();
    for (const tree of trees)
      for (const [rel, side] of tree.paths)
        byPath.set(rel, [...(byPath.get(rel) ?? []), { tree, side }]);
    const paths = [...byPath]
      .filter(([, list]) => list.length > 1)
      .map(([rel, list]) => crossingPath(rel, list))
      .sort((a, b) => RANK(a.overlap) - RANK(b.overlap) || b.last - a.last || cmp(a.path, b.path));
    out.push({
      root: repo.root,
      name: repo.name,
      trees: trees.map((t) => t.ref),
      paths,
      cut: repo.cut,
    });
  }
  return out.sort((a, b) => b.paths.length - a.paths.length || cmp(a.name, b.name));
}

/** A run of lines as the panel writes it: "40–43", "41"; where lines went in, the line after. */
export const spanText = (s: LineSpan) => (s.to > s.from ? `${s.from}–${s.to}` : `${s.from}`);
