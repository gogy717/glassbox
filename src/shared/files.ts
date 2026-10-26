/**
 * What a session did to files, read from its tool calls' inputs alone (`ToolCall.input`): the
 * files read, searched, edited, created and deleted, by which calls, with the edits themselves.
 * The Files tab's model, and the outcome strip's count of files (`outcome.ts`), so the two agree.
 * It never looks at the file system, so a file is whatever a call named.
 */
import type { IsoTime, LineChange, ToolCall } from '../core/model.js';
import { field, isObj, isUrl, type Obj, pathField } from './tool-category.js';

export type FileVerb = 'edited' | 'created' | 'deleted' | 'read' | 'searched';
export const VERBS: readonly FileVerb[] = ['edited', 'created', 'deleted', 'read', 'searched'];

/** One `old → new` of an edit. */
export interface Replacement {
  before: string;
  after: string;
  /** Every occurrence, not the first. */
  all: boolean;
}

/** What a call changed, as far as its input tells: unfolded under the file's row. */
export type EditDetail =
  | { kind: 'replace'; edits: Replacement[] }
  | { kind: 'write'; content: string }
  /** The lines of a patch for this one file. */
  | { kind: 'patch'; hunk: string }
  | {
      kind: 'notebook';
      cellId: string | null;
      mode: string | null;
      cellType: string | null;
      source: string | null;
    }
  /** A read, a search, a delete, or an edit whose shape glassbox does not read. */
  | { kind: 'none' };

/** One call's effect on one file, as the call names the file. */
export interface RawTouch {
  path: string;
  verb: FileVerb;
  /**
   * The lines a read named by its offset and limit, as "36-65"; an edit's, where the agent
   * recorded them (`editLines`).
   */
  lines: string | null;
  detail: EditDetail;
}

/** One call's effect on one file, placed under that file's row. */
export interface FileTouch {
  tool: ToolCall;
  verb: FileVerb;
  lines: string | null;
  detail: EditDetail;
}

export interface FileRow {
  /** The path as resolved (absolute when the cwd is known); one row per key. */
  key: string;
  /** As shown: relative to the cwd, or whole with the home directory as "~". */
  path: string;
  /** The directory of `path`: "" for the cwd itself, "/" or "~" for those roots. */
  dir: string;
  name: string;
  /** Not under the session's working directory. */
  outside: boolean;
  /** In time order. */
  touches: FileTouch[];
  /** Calls that finished, per verb; failed and running ones are counted apart. */
  counts: Record<FileVerb, number>;
  failed: number;
  running: number;
  /** When the last call on it ended (or started, while it runs). */
  lastAt: IsoTime | null;
}

/** The rows of one directory, in order. */
export interface FileGroup {
  dir: string;
  outside: boolean;
  rows: FileRow[];
}

/** The head line: files, and how many of them each verb was done to (a file counts once a verb). */
export interface FilesSummary {
  files: number;
  edited: number;
  created: number;
  deleted: number;
  read: number;
  searched: number;
}

export interface Files {
  rows: FileRow[];
  groups: FileGroup[];
  summary: FilesSummary;
}

// ── Which tools, and what they do ─────────────────────────────────────────────────────────

/** Tools that read one file: Claude Code, Codex and Grok, oh-my-pi and OpenCode. */
const READERS = new Set(['Read', 'NotebookRead', 'read_file', 'read', 'view_image']);
/** Tools that search or list a place: counted only by the path they were given, never by what they found. */
const SEARCHERS = new Set([
  'Grep',
  'Glob',
  'LS',
  'grep',
  'grep_files',
  'glob',
  'find',
  'search',
  'ast_grep',
  'list',
  'list_dir',
  'ls',
]);
/** Tools that write a whole file. */
const WRITERS = new Set(['Write', 'write', 'write_file']);
/** Tools that replace text in a file (some by a shape glassbox does not read: the file still shows). */
const REPLACERS = new Set([
  'Edit',
  'MultiEdit',
  'edit',
  'multiedit',
  'search_replace',
  'StrReplace',
  'hashline_edit',
  'ast_edit',
]);
const NOTEBOOK_EDITORS = new Set(['NotebookEdit', 'EditNotebook']);
/** Tools that take a patch (Codex and OpenCode `apply_patch`, OpenCode `patch`). */
const PATCHERS = new Set(['apply_patch', 'patch']);
const DELETERS = new Set(['Delete']);

/** Past this, a string input is not worth parsing. */
const PARSE_MAX = 100_000;
/** A path with these in it is a glob (oh-my-pi's glob takes its pattern as the path). */
const GLOB = /[*?[{]/;

const OLD_KEYS = ['old_string', 'oldString', 'oldText', 'old_str'];
const NEW_KEYS = ['new_string', 'newString', 'newText', 'new_str'];
const CONTENT_KEYS = ['content', 'contents', 'text'];

/** A tool's patch: Codex's apply_patch takes the text itself or `input`; OpenCode's, `patchText`. */
function patchText(input: unknown): string | null {
  if (typeof input === 'string') return /^\s*\*\*\* Begin Patch/.test(input) ? input : null;
  return field(input, 'input') ?? field(input, 'patchText');
}

export interface PatchSection {
  verb: FileVerb;
  path: string;
  /** The section's own lines, the header left out; a move stays with the file it renames. */
  hunk: string;
}

/**
 * The files a patch touches, each with its own lines: `*** Add File:` creates, `*** Update
 * File:` edits (its `*** Move to:` kept in the lines), `*** Delete File:` deletes.
 */
export function patchSections(patch: string): PatchSection[] {
  const out: PatchSection[] = [];
  let current: PatchSection | null = null;
  for (const line of patch.split('\n')) {
    const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (head) {
      const verb = head[1] === 'Add' ? 'created' : head[1] === 'Update' ? 'edited' : 'deleted';
      current = { verb, path: (head[2] ?? '').trim(), hunk: '' };
      out.push(current);
    } else if (/^\*\*\* (Begin|End) Patch\s*$/.test(line)) current = null;
    else if (current) current.hunk += current.hunk ? `\n${line}` : line;
  }
  return out.filter((s) => s.path !== '');
}

function replacement(o: unknown): Replacement | null {
  if (!isObj(o)) return null;
  const before = OLD_KEYS.map((k) => o[k]).find((v) => typeof v === 'string');
  const after = NEW_KEYS.map((k) => o[k]).find((v) => typeof v === 'string');
  if (typeof before !== 'string' || typeof after !== 'string') return null;
  return { before, after, all: o.replace_all === true || o.replaceAll === true };
}

/** An edit's replacements: its `edits` (MultiEdit, multiedit), else the one it names itself. */
function replacements(input: Obj): Replacement[] {
  if (Array.isArray(input.edits))
    return input.edits.map(replacement).filter((r): r is Replacement => r !== null);
  const one = replacement(input);
  return one ? [one] : [];
}

/** The lines a read names: `offset` (1-based) and `limit`, as "36-65"; "36" with no limit. */
function readLines(input: Obj): string | null {
  const { offset: o, limit: l } = input;
  if (typeof o !== 'number') return null;
  return typeof l === 'number' ? `${o}-${o + l - 1}` : `${o}`;
}

/** Runs an edit's lines name before "…". */
const SHOWN_RUNS = 3;

/**
 * Where an edit's changes sit in the file as it left it, written as a read's lines are: "41-43",
 * "36-38, 44-46"; a run only removed reads as the line where it was. Three runs, then "…".
 */
export function editLines(changes: readonly LineChange[]): string | null {
  if (changes.length === 0) return null;
  let shift = 0;
  const runs = changes.map(([at, removed, added]) => {
    const from = at + shift;
    shift += added - removed;
    return added > 1 ? `${from}-${from + added - 1}` : `${from}`;
  });
  return runs.length > SHOWN_RUNS ? `${runs.slice(0, SHOWN_RUNS).join(', ')}, …` : runs.join(', ');
}

/** The result of a Write that found the file there (Claude Code says so); a new file otherwise. */
const OVERWROTE = /has been updated/;

/**
 * What one call did to which files, by the tool's name and its input: nothing for a tool that
 * is not a file tool (a shell command, a sub-agent, a web fetch, an MCP tool) or whose input
 * names no file. A search counts only the path it was given, never its matches.
 */
export function touchesOf(tool: ToolCall): RawTouch[] {
  const name = tool.name;
  let input = tool.input;
  // Arguments that arrived as JSON text (OpenCode's raw input); cut short, they name nothing.
  if (typeof input === 'string' && /^\s*\{/.test(input) && input.length <= PARSE_MAX) {
    try {
      input = JSON.parse(input);
    } catch {
      return [];
    }
  }
  if (PATCHERS.has(name)) {
    const patch = patchText(input);
    if (!patch) return [];
    return patchSections(patch).map((s) => ({
      path: s.path,
      verb: s.verb,
      lines: null,
      detail: { kind: 'patch', hunk: s.hunk },
    }));
  }
  if (!isObj(input)) return [];
  const path = pathField(input);
  if (!path || isUrl(path)) return [];
  const none: EditDetail = { kind: 'none' };
  // An edit of one file: where it landed, when the agent recorded it.
  const changed = tool.lineChanges ? editLines(tool.lineChanges) : null;
  if (READERS.has(name)) return [{ path, verb: 'read', lines: readLines(input), detail: none }];
  if (SEARCHERS.has(name))
    return GLOB.test(path) ? [] : [{ path, verb: 'searched', lines: null, detail: none }];
  if (WRITERS.has(name)) {
    const content = CONTENT_KEYS.map((k) => field(input, k)).find((v) => v !== null) ?? '';
    const verb = OVERWROTE.test(tool.resultPreview ?? '') ? 'edited' : 'created';
    return [{ path, verb, lines: changed, detail: { kind: 'write', content } }];
  }
  if (NOTEBOOK_EDITORS.has(name)) {
    const n = input.cell_number;
    const detail: EditDetail = {
      kind: 'notebook',
      cellId: field(input, 'cell_id') ?? (typeof n === 'number' ? String(n) : null),
      mode: field(input, 'edit_mode'),
      cellType: field(input, 'cell_type'),
      source: field(input, 'new_source'),
    };
    return [{ path, verb: 'edited', lines: null, detail }];
  }
  if (REPLACERS.has(name)) {
    const edits = replacements(input);
    const detail: EditDetail = edits.length > 0 ? { kind: 'replace', edits } : none;
    return [{ path, verb: 'edited', lines: changed, detail }];
  }
  if (DELETERS.has(name)) return [{ path, verb: 'deleted', lines: null, detail: none }];
  return [];
}

// ── Paths ─────────────────────────────────────────────────────────────────────────────────

/** A home directory by its shape, as the receipt reads one: /home/x, /Users/x, /mnt/c/Users/x, C:\Users\x. */
const HOME =
  /^((?:\/var)?\/home\/[^/]+|\/Users\/[^/]+|\/mnt\/[a-z]\/Users\/[^/]+|[a-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/i;

/** The separator a path is written with: "\" only when it has no "/" at all. */
const sepOf = (p: string) => (p.includes('/') || !p.includes('\\') ? '/' : '\\');
const isAbsolute = (p: string) => /^([\\/]|[a-z]:[\\/]|~(?=[\\/]|$))/i.test(p);

/**
 * `raw` as one path: trimmed, a leading "./" dropped, a relative path placed under the cwd,
 * "~" expanded to the cwd's home directory when the cwd is in one, separators collapsed and a
 * trailing one removed. Two calls that name the same file then share a row.
 */
export function resolvePath(raw: string, cwd: string | null): string {
  let p = raw.trim().replace(/^(\.[\\/])+/, '');
  if (/^~(?=[\\/]|$)/.test(p)) {
    const home = cwd ? HOME.exec(cwd)?.[1] : undefined;
    if (home) p = home + p.slice(1);
  } else if (p !== '' && p !== '.' && !isAbsolute(p) && cwd) p = `${cwd}${sepOf(cwd)}${p}`;
  else if (p === '' || p === '.') p = cwd ?? p;
  const sep = sepOf(p);
  // A UNC path keeps its leading two separators.
  const unc = sep === '\\' && p.startsWith('\\\\') ? '\\\\' : '';
  p = unc + p.slice(unc.length).replace(sep === '/' ? /\/{2,}/g : /\\{2,}/g, sep);
  if (p.length > 1) p = p.replace(sep === '/' ? /\/+$/ : /\\+$/, '') || sep;
  return p;
}

export interface ShownPath {
  path: string;
  dir: string;
  name: string;
  outside: boolean;
}

/**
 * How a resolved path is shown: inside the cwd, relative to it; outside, whole, with the home
 * directory as "~" (as the receipt prints one). Its directory groups it, its name heads its row.
 */
export function shownPath(key: string, cwd: string | null): ShownPath {
  const sep = sepOf(key);
  const inside = cwd !== null && key.startsWith(cwd + sepOf(cwd));
  const path = inside ? key.slice((cwd as string).length + 1) : key.replace(HOME, '~');
  const parts = path.split(/[\\/]/);
  const name = parts.pop() ?? path;
  let dir = parts.join(sep);
  // "/hosts": the root is its directory, not nothing.
  if (dir === '' && parts.length === 1) dir = sep;
  return { path, dir, name, outside: !inside };
}

// ── Rows ──────────────────────────────────────────────────────────────────────────────────

/** What the rows are read from: a session's working directory and its tool calls by id. */
export interface FilesSource {
  session: { cwd: string | null };
  toolCalls: ReadonlyMap<string, ToolCall>;
}

const ms = (iso: IsoTime | null) => (iso === null ? Number.NaN : Date.parse(iso));

/** By start (epoch ms); a call with no start, or one that does not parse, goes last. */
function byStart(x: number, y: number): number {
  if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : 1;
  if (Number.isNaN(y)) return -1;
  return x - y;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The cwd's files first, directory by directory, then the paths outside it; names in order. */
const byPlace = (a: FileRow, b: FileRow) =>
  Number(a.outside) - Number(b.outside) || cmp(a.dir, b.dir) || cmp(a.name, b.name);

const noCounts = (): Record<FileVerb, number> => ({
  edited: 0,
  created: 0,
  deleted: 0,
  read: 0,
  searched: 0,
});

/** Rows in order, cut into their directories. */
export function groupFiles(rows: FileRow[]): FileGroup[] {
  const groups: FileGroup[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.dir === row.dir && last.outside === row.outside) last.rows.push(row);
    else groups.push({ dir: row.dir, outside: row.outside, rows: [row] });
  }
  return groups;
}

function summarize(rows: FileRow[]): FilesSummary {
  const s: FilesSummary = {
    files: rows.length,
    edited: 0,
    created: 0,
    deleted: 0,
    read: 0,
    searched: 0,
  };
  for (const row of rows) for (const verb of VERBS) if (row.counts[verb] > 0) s[verb]++;
  return s;
}

/**
 * The files the given agents' calls touched: one row per file, in time order within a row, the
 * rows grouped by directory. A search or listing of the working directory itself says nothing
 * about a file and is left out.
 */
export function buildFiles(open: FilesSource, agentIds: ReadonlySet<string>): Files {
  const cwd = open.session.cwd;
  const byKey = new Map<string, FileRow>();
  // Each start parsed once, not twice a comparison: a session can hold thousands of calls.
  const tools = [...open.toolCalls.values()]
    .filter((t) => agentIds.has(t.agentId))
    .map((t) => [ms(t.startedAt), t] as const)
    .sort(([x], [y]) => byStart(x, y))
    .map(([, t]) => t);
  for (const tool of tools) {
    for (const raw of touchesOf(tool)) {
      const key = resolvePath(raw.path, cwd);
      if (key === cwd) continue;
      let row = byKey.get(key);
      if (!row) {
        row = {
          key,
          ...shownPath(key, cwd),
          touches: [],
          counts: noCounts(),
          failed: 0,
          running: 0,
          lastAt: null,
        };
        byKey.set(key, row);
      }
      row.touches.push({ tool, verb: raw.verb, lines: raw.lines, detail: raw.detail });
      if (tool.status === 'error') row.failed++;
      else if (tool.status === 'running') row.running++;
      else row.counts[raw.verb]++;
      const at = tool.endedAt ?? tool.startedAt;
      if (at !== null && !(ms(at) <= ms(row.lastAt))) row.lastAt = at;
    }
  }
  const rows = [...byKey.values()].sort(byPlace);
  return { rows, groups: groupFiles(rows), summary: summarize(rows) };
}
