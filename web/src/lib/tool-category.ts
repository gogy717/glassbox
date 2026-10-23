/** What kind of work a tool call is, and a one-line description of it. */
import type { ToolCall } from '../../../src/core/model.js';
import { quotedValue } from './preview';

export type ToolCategory =
  | 'explore'
  | 'edit'
  | 'run'
  | 'git'
  | 'delegate'
  | 'ask'
  | 'plan'
  | 'web'
  | 'mcp'
  | 'other';

/** Built-in tools of every agent, by the name its sessions record; a shared name is listed once. */
const BY_NAME: Record<string, ToolCategory> = {
  // Claude Code
  Read: 'explore',
  Grep: 'explore',
  Glob: 'explore',
  LS: 'explore',
  NotebookRead: 'explore',
  LSP: 'explore',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'run',
  BashOutput: 'run',
  KillShell: 'run',
  TaskOutput: 'run',
  TaskStop: 'run',
  Monitor: 'run',
  EnterWorktree: 'git',
  ExitWorktree: 'git',
  Agent: 'delegate',
  Task: 'delegate',
  Workflow: 'delegate',
  SendMessage: 'delegate',
  ListAgents: 'delegate',
  AskUserQuestion: 'ask',
  TodoWrite: 'plan',
  TaskCreate: 'plan',
  TaskUpdate: 'plan',
  TaskList: 'plan',
  TaskGet: 'plan',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan',
  Skill: 'plan',
  WebFetch: 'web',
  WebSearch: 'web',
  ListMcpResourcesTool: 'mcp',
  ReadMcpResourceTool: 'mcp',
  // Codex
  read_file: 'explore', // and Grok
  list_dir: 'explore', // and Grok
  grep_files: 'explore',
  view_image: 'explore',
  apply_patch: 'edit', // and OpenCode
  shell: 'run',
  local_shell: 'run',
  exec: 'run',
  exec_command: 'run',
  write_stdin: 'run',
  spawn_agent: 'delegate',
  send_input: 'delegate',
  send_message: 'delegate',
  followup_task: 'delegate',
  wait: 'delegate', // and oh-my-pi; a wait on an exec cell is run (toolCategory)
  wait_agent: 'delegate',
  close_agent: 'delegate',
  resume_agent: 'delegate',
  interrupt_agent: 'delegate',
  list_agents: 'delegate',
  request_user_input: 'ask',
  request_user_input_async: 'ask',
  update_plan: 'plan',
  web_search: 'web', // and Grok, oh-my-pi
  list_mcp_resources: 'mcp',
  list_mcp_resource_templates: 'mcp',
  read_mcp_resource: 'mcp',
  // Grok, and the tools of its Cursor preset
  grep: 'explore', // and oh-my-pi, OpenCode
  search_replace: 'edit',
  hashline_edit: 'edit',
  write_file: 'edit',
  StrReplace: 'edit',
  EditNotebook: 'edit',
  Delete: 'edit',
  run_terminal_command: 'run',
  Shell: 'run',
  AwaitShell: 'run',
  get_command_or_subagent_output: 'run',
  kill_command_or_subagent: 'run',
  wait_commands_or_subagents: 'run',
  get_task_output: 'run',
  kill_task: 'run',
  wait_tasks: 'run',
  spawn_subagent: 'delegate',
  send_subagent_message: 'delegate',
  ask_user_question: 'ask',
  AskQuestion: 'ask',
  todo_write: 'plan',
  enter_plan_mode: 'plan',
  exit_plan_mode: 'plan',
  update_goal: 'plan',
  web_fetch: 'web',
  search_tool: 'mcp',
  use_tool: 'mcp',
  // oh-my-pi
  read: 'explore', // and OpenCode
  search: 'explore',
  glob: 'explore', // and OpenCode
  find: 'explore',
  ast_grep: 'explore',
  lsp: 'explore', // and OpenCode
  recall: 'explore',
  edit: 'edit', // and OpenCode
  write: 'edit', // and OpenCode
  ast_edit: 'edit',
  bash: 'run', // and OpenCode
  eval: 'run',
  debug: 'run',
  ssh: 'run',
  github: 'git',
  task: 'delegate', // and OpenCode
  vibe_spawn: 'delegate',
  vibe_send: 'delegate',
  vibe_wait: 'delegate',
  vibe_list: 'delegate',
  vibe_kill: 'delegate',
  ask: 'ask',
  todo: 'plan',
  goal: 'plan',
  manage_skill: 'plan',
  browser: 'web',
  // OpenCode
  list: 'explore',
  ls: 'explore', // older id, still in the adapter's fixtures
  multiedit: 'edit',
  patch: 'edit',
  question: 'ask',
  todowrite: 'plan',
  todoread: 'plan',
  skill: 'plan',
  webfetch: 'web',
  websearch: 'web',
  codesearch: 'web',
};

/** Tools whose input is a shell command (`command`, Codex's argv, or `cmd`). */
const SHELLS = new Set([
  'Bash',
  'Shell',
  'shell',
  'local_shell',
  'exec_command',
  'run_terminal_command',
  'bash',
]);

const READ_ONLY = new Set([
  'rg',
  'grep',
  'egrep',
  'ls',
  'cat',
  'head',
  'tail',
  'find',
  'fd',
  'tree',
  'wc',
  'less',
  'more',
  'pwd',
  'which',
  'file',
  'stat',
  'du',
  'df',
  'jq',
  'echo',
  'sort',
  'uniq',
  'cut',
  'cd',
]);
const READ_ONLY_GIT = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'grep',
  'ls-files',
  'rev-parse',
]);
/** `gh <noun> <verb>` verbs that only look. */
const READ_ONLY_GH = new Set(['view', 'list', 'status', 'diff', 'checks']);
/** git's global options whose value is the next word. */
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
]);

/** A shell command that only looks around (rg, ls, git log…) is exploring, not running. */
const FIND_ACTIONS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprintf',
  '-fls',
]);

/** Each command of a pipeline or list, as words, without its leading `VAR=value`s. */
function segments(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim().replace(/^(\w+=\S*\s+)+/, ''))
    .filter(Boolean)
    .map((s) => s.split(/\s+/));
}

/** git's subcommand, past its global options (`-C dir`, `--git-dir .git`, `--no-pager`). */
function gitSubcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (GIT_VALUE_OPTIONS.has(arg)) i++;
    else if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

/**
 * gh that only looks: `gh status`, `gh <noun> view|list|…`, and `gh api` reading, which it does
 * unless a method other than GET is given or fields are sent without one.
 */
function isReadOnlyGh(args: string[]): boolean {
  const [noun, verb] = args;
  if (noun === 'status') return true;
  if (noun !== 'api') return READ_ONLY_GH.has(verb ?? '');
  let method: string | null = null;
  let fields = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '-X' || arg === '--method') method = args[++i] ?? '';
    else if (arg.startsWith('--method=')) method = arg.slice('--method='.length);
    else if (/^-X./.test(arg)) method = arg.slice(2);
    else if (/^(-[fF]|--field|--raw-field|--input)(=|$)|^-[fF]./.test(arg)) fields = true;
  }
  return method === null ? !fields : method.toUpperCase() === 'GET';
}

function isReadOnlySegment([cmd, ...args]: string[]): boolean {
  if (!cmd) return true;
  if (cmd === 'git') return READ_ONLY_GIT.has(gitSubcommand(args) ?? '');
  if (cmd === 'gh') return isReadOnlyGh(args);
  if (cmd === 'find') return !args.some((a) => FIND_ACTIONS.has(a));
  if (cmd === 'sed') return !args.some((a) => a.startsWith('-i'));
  return READ_ONLY.has(cmd);
}

function isReadOnlyCommand(command: string): boolean {
  // Command substitution can run anything.
  if (/\$\(|`/.test(command)) return false;
  // Redirection writes a file, except duplicating a stream (2>&1) or discarding it (/dev/null).
  const withoutHarmless = command.replace(/\d*>&\d+/g, '').replace(/\d*&?>>?\s*\/dev\/null/g, '');
  if (withoutHarmless.includes('>')) return false;
  return segments(command).every(isReadOnlySegment);
}

/**
 * Exploring when it only looks; git when it starts (after any `cd dir &&`) with a git or gh
 * command that changes something, so a commit whose message is a heredoc still counts.
 */
function shellCategory(command: string): ToolCategory {
  if (isReadOnlyCommand(command)) return 'explore';
  const first = segments(command).find(([cmd]) => cmd !== 'cd');
  const isGit = first?.[0] === 'git' || first?.[0] === 'gh';
  return first && isGit && !isReadOnlySegment(first) ? 'git' : 'run';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function field(input: unknown, key: string): string | null {
  const v = isObj(input) ? input[key] : undefined;
  return typeof v === 'string' ? v : null;
}

const SHELL_BIN = /(^|[\\/])((ba|z|da|k)?sh|pwsh|powershell)(\.exe)?$/i;

/** The command line of a shell call: `command` (a string, or Codex's argv) or `cmd`. */
function shellCommand(input: unknown): string | null {
  const v = isObj(input) ? (input.command ?? input.cmd) : undefined;
  if (typeof v === 'string') return v;
  if (!Array.isArray(v) || !v.every((a): a is string => typeof a === 'string')) return null;
  // ["bash", "-lc", "rg x"] runs its last word.
  const [bin = '', ...rest] = v;
  if (rest.length >= 2 && SHELL_BIN.test(bin) && /^(-\w*c|-command)$/i.test(rest.at(-2) ?? ''))
    return rest.at(-1) ?? '';
  return v.join(' ');
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

/**
 * An MCP tool's server and name: `mcp__server__tool`, or `server__tool` as Grok (and older
 * Codex) name them. Built-in tool names never hold `__`.
 */
export function mcpTool(name: string): { server: string; tool: string } | null {
  const m = name.startsWith('mcp__')
    ? /^mcp__(.+?)__(.+)$/.exec(name)
    : /^([A-Za-z0-9][\w.-]*?)__(.+)$/.exec(name);
  return m?.[1] && m[2] ? { server: m[1], tool: m[2] } : null;
}

/** MCP servers that drive a browser are web work, like WebFetch. */
const BROWSER_MCP = /chrome|browser|playwright|puppeteer/i;

export function toolCategory(name: string, input?: unknown): ToolCategory {
  if (SHELLS.has(name)) {
    const command = shellCommand(input);
    return command === null ? 'run' : shellCategory(command);
  }
  // Codex's wait is on a code cell it runs; oh-my-pi's on agents.
  if (name === 'wait' && isObj(input) && 'cell_id' in input) return 'run';
  // oh-my-pi reads web pages with the same tool as files.
  if (name === 'read' && isUrl(field(input, 'path') ?? '')) return 'web';
  if (Object.hasOwn(BY_NAME, name)) return BY_NAME[name] as ToolCategory;
  const mcp = mcpTool(name);
  if (mcp) return BROWSER_MCP.test(mcp.server) ? 'web' : 'mcp';
  return 'other';
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

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
