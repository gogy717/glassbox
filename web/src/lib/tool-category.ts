/** A one-line description of a tool call, and what kind of work it is (`toolCategory`). */
import type { ToolCall } from '../../../src/core/model.js';
import {
  field,
  isObj,
  isUrl,
  type Obj,
  SHELLS,
  shellCommand,
  toolCategory,
} from '../../../src/shared/tool-category.js';
import { quotedValue } from './preview';

export { mcpTool, type ToolCategory, toolCategory } from '../../../src/shared/tool-category.js';

export const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const MAX = 80;
const clip = (s: string) => {
  // Only the start shows: collapse the whitespace of that, not of a megabyte of input.
  const head = s.slice(0, MAX * 4);
  const line = head.replace(/\s+/g, ' ').trim();
  return line.length > MAX || head.length < s.trimEnd().length ? `${line.slice(0, MAX)}…` : line;
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The files a patch touches (`*** Update File: src/a.ts`), by name. */
function patchFiles(patch: string): string | null {
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) =>
    basename((m[1] ?? '').trim()),
  );
  return files.length ? clip(files.join(', ')) : null;
}

/** Where a file lives, whatever the agent calls the key. */
const PATH_KEYS = [
  'file_path',
  'filePath',
  'path',
  'target_file',
  'notebook_path',
  'target_notebook',
  'dir_path',
  'target_directory',
];
/** What a call says it is for: an agent's task label, or oh-my-pi's intent (`i`). */
const LABEL_KEYS = ['description', 'task_name', 'i'];

/** The item a todo list or plan is on (TodoWrite, update_plan, todowrite…): in progress, else next, else last. */
function currentItem(input: Obj): string | null {
  const list = input.todos ?? input.plan;
  if (!Array.isArray(list)) return null;
  const item =
    list.find((x) => isObj(x) && x.status === 'in_progress') ??
    list.find((x) => isObj(x) && x.status === 'pending') ??
    list.at(-1);
  return field(item, 'content') ?? field(item, 'step');
}

/** Past this, a string input is not worth parsing for a one-line summary. */
const PARSE_MAX = 100_000;

/**
 * Input that arrived as a string. Arguments that did not parse come this way (OpenCode's pending
 * raw input, Codex's broken function arguments): summarized as the object they hold, or by their
 * first value, never shown as JSON.
 */
function stringInput(tool: ToolCall, input: string): string {
  if (!/^\s*[[{]/.test(input)) return clip(input);
  if (input.length <= PARSE_MAX) {
    try {
      const parsed: unknown = JSON.parse(input);
      return isObj(parsed) ? summarizeInput({ ...tool, input: parsed }) : '';
    } catch {
      // Cut short: fall through to its first value.
    }
  }
  return clip(quotedValue(input) ?? '');
}

/**
 * The path a call's input names, whatever the agent calls the key (`file_path`, `filePath`,
 * `path`, `target_file`…), as written: a search's directory as much as a read's file, a URL as
 * much as a path. Null when the input names none.
 */
export function pathField(input: unknown): string | null {
  return PATH_KEYS.map((k) => field(input, k)).find(Boolean) ?? null;
}

/**
 * The file a call's summary names by its basename (a read, an edit, a listing), whole, so a view
 * with room can show more of it; null when the summary is something else (a command, a pattern,
 * a URL, a glob).
 */
export function inputPath(tool: ToolCall): string | null {
  const input = tool.input;
  if (!isObj(input) || tool.name === 'glob' || tool.name === 'Workflow') return null;
  const f = (k: string) => field(input, k);
  if (shellCommand(input) || f('pattern') || f('query') || f('url')) return null;
  const path = pathField(input);
  return path && !isUrl(path) ? path : null;
}

/** One line saying what the call did: the command, the file, the pattern, the host… */
export function summarizeInput(tool: ToolCall): string {
  const input = tool.input;
  if (tool.name === 'Workflow') {
    const name = /\bname:\s*['"]([^'"]+)['"]/.exec(field(input, 'script') ?? '')?.[1];
    if (name) return name;
    const path = field(input, 'scriptPath');
    if (path) return basename(path).replace(/\.[cm]?[jt]s$/, '');
  }
  if (tool.name === 'apply_patch' || tool.name === 'patch') {
    const patch =
      typeof input === 'string' ? input : (field(input, 'input') ?? field(input, 'patchText'));
    const files = patch && patchFiles(patch);
    if (files) return files;
  }
  // Codex's exec runs JavaScript, after an optional `// @exec: {…}` line of settings.
  if (typeof input === 'string' && tool.name === 'exec')
    return clip(input.replace(/^\s*\/\/ @exec:.*\n/, ''));
  if (typeof input === 'string') return stringInput(tool, input);
  if (!isObj(input)) return '';

  const f = (k: string) => field(input, k);
  const command = shellCommand(input);
  if (command) return clip(command);
  const pattern = f('pattern') ?? f('query');
  if (pattern) return clip(pattern);
  const url = f('url');
  if (url) return hostOf(url);
  const path = PATH_KEYS.map(f).find(Boolean);
  if (path) {
    // oh-my-pi's glob takes its pattern as the path.
    if (tool.name === 'glob') return clip(path);
    if (isUrl(path)) return hostOf(path);
    const { offset: o, limit: l } = input;
    if (typeof o === 'number')
      return `${basename(path)}:${o}${typeof l === 'number' ? `-${o + l - 1}` : ''}`;
    return basename(path);
  }
  const item = currentItem(input);
  if (item) return clip(item);
  const question = Array.isArray(input.questions) ? field(input.questions[0], 'question') : null;
  if (question) return clip(question);
  const label = LABEL_KEYS.map(f).find(Boolean);
  if (label) return clip(label);
  // Never JSON: the first plain value, else the field names.
  const entries = Object.entries(input);
  const text = entries.find(([, v]) => typeof v === 'string' && v.trim() !== '');
  if (text) return clip(text[1] as string);
  const scalar = entries.find(([, v]) => typeof v === 'number' || typeof v === 'boolean');
  if (scalar) return `${scalar[0]}: ${scalar[1]}`;
  return clip(entries.map(([k]) => k).join(', '));
}

/** Adapters cut a tool's result preview at this many characters (`PREVIEW_CHARS`). */
const PREVIEW_CHARS = 500;

/** What a finished call's result line says: a message key, and a count for it. */
export interface ResultSummary {
  key:
    | 'matches'
    | 'matchesMore'
    | 'noMatches'
    | 'files'
    | 'filesMore'
    | 'noFiles'
    | 'lines'
    | 'linesMore'
    | 'read'
    | 'noOutput'
    | 'edited'
    | 'written'
    | 'launched'
    | 'delivered'
    | 'answered'
    | 'updated'
    | 'fetched'
    | 'searched'
    | 'json'
    | 'text'
    | 'done';
  n?: number;
}

const SEARCH = new Set(['Grep', 'grep', 'grep_files', 'search', 'ast_grep']);
const LISTING = new Set(['Glob', 'LS', 'list_dir', 'glob', 'find', 'list', 'ls']);
const WRITERS = new Set(['Write', 'write', 'write_file']);
const SENDERS = new Set([
  'SendMessage',
  'send_message',
  'send_input',
  'send_subagent_message',
  'followup_task',
  'vibe_send',
]);
const SEARCH_COMMAND = /^\s*(rg|grep|egrep|git grep|ag)\b/;
const NONE_FOUND = /^No (matches|files) found/i;
const NO_OUTPUT = /^\(?[\w ]*completed with no output\)?$|^\(no output\)$/i;
const LAUNCHED = /\blaunched\b|\bin the background\b|\basync(hronously)?\b/i;

/**
 * A finished call's outcome in a few words, by what kind of work it was: "3 matches",
 * "212 lines", "no output", "edited", "launched · async", "delivered", else "done". Counts come
 * from the result preview; a preview cut at its limit gives a lower bound ("22+ lines"), or no
 * count for a file read, whose length it cannot know. Never the result's own words or quotes.
 */
export function summarizeResult(tool: ToolCall): ResultSummary {
  const raw = tool.resultPreview ?? '';
  const text = raw.trim();
  const cut = raw.length >= PREVIEW_CHARS;
  const lines = text ? text.split('\n').filter((l) => l.trim()).length : 0;
  const count = (key: 'matches' | 'files' | 'lines'): ResultSummary => ({
    key: cut ? `${key}More` : key,
    n: lines,
  });
  const name = tool.name;
  const category = toolCategory(name, tool.input);
  const command = SHELLS.has(name) ? shellCommand(tool.input) : null;

  if (category === 'explore' || (command !== null && SEARCH_COMMAND.test(command))) {
    const found = /^Found (\d+) (files?|total occurrences)/.exec(text);
    if (found)
      return { key: found[2]?.startsWith('file') ? 'files' : 'matches', n: Number(found[1]) };
    if (SEARCH.has(name) || (command !== null && SEARCH_COMMAND.test(command)))
      return !text || NONE_FOUND.test(text) ? { key: 'noMatches' } : count('matches');
    if (LISTING.has(name))
      return !text || NONE_FOUND.test(text) ? { key: 'noFiles' } : count('files');
    if (command === null) return cut || !text ? { key: 'read' } : count('lines');
  }
  if (category === 'run' || category === 'explore')
    return !text || NO_OUTPUT.test(text) ? { key: 'noOutput' } : count('lines');
  if (category === 'edit') return { key: WRITERS.has(name) ? 'written' : 'edited' };
  if (category === 'delegate')
    return SENDERS.has(name)
      ? { key: 'delivered' }
      : { key: LAUNCHED.test(text) ? 'launched' : 'done' };
  if (category === 'ask') return { key: 'answered' };
  if (category === 'plan') return { key: 'updated' };
  if (category === 'web') return { key: /search/i.test(name) ? 'searched' : 'fetched' };
  if (category === 'mcp') return { key: /^[[{]/.test(text) ? 'json' : 'text' };
  return { key: 'done' };
}
