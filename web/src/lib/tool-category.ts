/** What kind of work a tool call is, and a one-line description of it. */
import type { ToolCall } from '../../../src/core/model.js';

export type ToolCategory =
  | 'explore'
  | 'edit'
  | 'run'
  | 'delegate'
  | 'ask'
  | 'plan'
  | 'web'
  | 'other';

const BY_NAME: Record<string, ToolCategory> = {
  Read: 'explore',
  Grep: 'explore',
  Glob: 'explore',
  LS: 'explore',
  NotebookRead: 'explore',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'run',
  BashOutput: 'run',
  KillShell: 'run',
  Agent: 'delegate',
  Task: 'delegate',
  Workflow: 'delegate',
  SendMessage: 'delegate',
  AskUserQuestion: 'ask',
  TodoWrite: 'plan',
  TaskCreate: 'plan',
  TaskUpdate: 'plan',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan',
  Skill: 'plan',
  WebFetch: 'web',
  WebSearch: 'web',
};

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

function isReadOnlyCommand(command: string): boolean {
  // Command substitution can run anything.
  if (/\$\(|`/.test(command)) return false;
  // Redirection writes a file, except duplicating a stream (2>&1) or discarding it (/dev/null).
  const withoutHarmless = command.replace(/\d*>&\d+/g, '').replace(/\d*&?>>?\s*\/dev\/null/g, '');
  if (withoutHarmless.includes('>')) return false;
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim().replace(/^(\w+=\S*\s+)+/, ''))
    .filter(Boolean)
    .every((segment) => {
      const [cmd, sub, ...rest] = segment.split(/\s+/);
      if (!cmd) return true;
      if (cmd === 'git') return READ_ONLY_GIT.has(sub ?? '');
      if (cmd === 'find')
        return ![sub, ...rest].some((a) => a !== undefined && FIND_ACTIONS.has(a));
      if (cmd === 'sed') return ![sub, ...rest].some((a) => a?.startsWith('-i'));
      return READ_ONLY.has(cmd);
    });
}

/** MCP servers that drive a browser are web work, like WebFetch. */
const BROWSER_MCP = /^mcp__[^_]*(chrome|browser|playwright|puppeteer)/i;

export function toolCategory(name: string, input?: unknown): ToolCategory {
  const byName = BY_NAME[name] ?? (BROWSER_MCP.test(name) ? 'web' : 'other');
  if (name === 'Bash') {
    const command = field(input, 'command');
    if (command && isReadOnlyCommand(command)) return 'explore';
  }
  return byName;
}

function field(input: unknown, key: string): string | null {
  if (!input || typeof input !== 'object') return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const MAX = 80;
const clip = (s: string) => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > MAX ? `${line.slice(0, MAX)}…` : line;
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** One line saying what the call did: the command, the file, the pattern, the host… */
export function summarizeInput(tool: ToolCall): string {
  const input = tool.input;
  if (typeof input === 'string') return clip(input);
  const f = (k: string) => field(input, k);
  switch (tool.name) {
    case 'Bash':
      return clip(f('command') ?? '');
    case 'Read': {
      const path = f('file_path');
      if (!path) break;
      const o = (input as Record<string, unknown>).offset;
      const l = (input as Record<string, unknown>).limit;
      if (typeof o === 'number')
        return `${basename(path)}:${o}${typeof l === 'number' ? `-${o + l - 1}` : ''}`;
      return basename(path);
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const path = f('file_path') ?? f('notebook_path');
      if (path) return basename(path);
      break;
    }
    case 'Grep':
    case 'Glob':
      if (f('pattern')) return clip(f('pattern') as string);
      break;
    case 'WebFetch':
      if (f('url')) return hostOf(f('url') as string);
      break;
    case 'WebSearch':
      if (f('query')) return clip(f('query') as string);
      break;
    case 'Agent':
    case 'Task':
      if (f('description')) return clip(f('description') as string);
      break;
    case 'Workflow': {
      const name = /\bname:\s*['"]([^'"]+)['"]/.exec(f('script') ?? '')?.[1];
      if (name) return name;
      const path = f('scriptPath');
      if (path) return basename(path).replace(/\.[cm]?[jt]s$/, '');
      break;
    }
  }
  if (input && typeof input === 'object') {
    const first = Object.values(input).find((v): v is string => typeof v === 'string');
    if (first) return clip(first);
  }
  return '';
}
