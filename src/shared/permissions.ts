/**
 * Permission rules mining: which calls a permission rule decides, keyed by the rule that would
 * allow them, and how each was answered.
 *
 * A call counts when a rule decides it: Claude Code's Bash, its file edits, WebFetch, WebSearch,
 * Skill and MCP tools, and a read outside the session's directory; Codex's commands that asked
 * to leave its sandbox, and the commands and patches it was refused. Its key is the rule in its
 * agent's syntax: `Bash(npm test:*)`, `Edit(src/**)`, `WebFetch(domain:docs.x.io)`,
 * `mcp__server__tool`; Codex's `prefix_rule(pattern=["npm", "test"])`. It was denied when the
 * person declined the prompt (the transcript's refusal, or a glassbox run's answer), allowed when
 * the call ran: a rule or a mode may have let it through without asking, which no transcript
 * says. Nothing records "don't ask again": Claude Code writes the rule to a settings file only.
 *
 * Pure, and free of Node built-ins: the web imports it.
 *
 * CONTRACT: the server and the web UI both depend on this file; change them together.
 */
import { hostOf, simpleCommands } from '../core/command-summary.js';
import type { AgentKind, IsoTime, SessionSnapshot, ToolCall } from '../core/model.js';
import { secretShaped } from '../core/redact.js';
import type { RunState } from './runs.js';
import { mcpTool, pathField, SHELLS, shellCommand } from './tool-category.js';

/** The call ran ('allowed'), or the person declined it ('denied'). */
export type PermissionAnswer = 'allowed' | 'denied';

/**
 * Why a rule should never be ticked for you: it deletes, runs as root, may force a push, runs any
 * command at all, ran a download through a shell, or edits outside the working tree.
 */
export type DangerKind = 'delete' | 'sudo' | 'force-push' | 'shell' | 'pipe-to-shell' | 'outside';

/** Where a session ran: file rules are written relative to `cwd`, home as "~". */
export interface SessionPlace {
  cwd: string | null;
  /** The working tree holding `cwd` (`RepoIdentity.dir`); an edit outside it is 'outside'. */
  tree: string | null;
  home: string | null;
}

/** The rule a call would need. */
export interface RuleKey {
  /** In its agent's rule syntax. */
  key: string;
  /**
   * What the rule names, to filter by: Bash, Edit, Read, WebFetch, WebSearch, Skill, an MCP
   * server (`mcp__tracker`), Codex's `prefix_rule` or `apply_patch`.
   */
  tool: string;
  danger: DangerKind | null;
}

/** One call a permission rule decides. */
export interface PermissionEvent extends RuleKey {
  agent: AgentKind;
  answer: PermissionAnswer;
  /** When the call was made: its start, else its model call's. */
  at: IsoTime;
  toolCallId: string;
}

// --- keys ----------------------------------------------------------------------------------

/** Commands that set up the ones after them: a rule is named by what they lead to. */
const SETUP = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'unset', 'source', '.', 'alias']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DELETES = new Set(['rm', 'rmdir', 'shred', 'unlink']);
const ADMIN = new Set(['sudo', 'su', 'doas']);
/** Programs that run whatever command they are given. */
const RUNS_ANY = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'eval',
  'exec',
  'xargs',
  'env',
  'nohup',
  'timeout',
  'nice',
  'time',
  'watch',
  'command',
]);
const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);
const FETCHES = new Set(['curl', 'wget']);
const FILE_EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const FILE_READS = new Set(['Read', 'Glob', 'Grep']);
const OTHER_RULES = new Set(['WebSearch', 'Skill']);
const CODEX_PATCH = 'apply_patch';

const programName = (word: string) => word.split('/').at(-1) ?? word;

/**
 * The words a prefix rule for `line` names: the first command that is not set-up, without its
 * leading NAME=value, as its program and the subcommand words the command summary names that
 * stand at its start (`npm test`, `git push`, `python3 -m pytest`); else the program alone. And
 * what harm such a rule may do. Null when it runs nothing that can be named.
 */
function commandPrefix(line: string): { words: string[]; danger: DangerKind | null } | null {
  const commands = simpleCommands(line);
  const chosen =
    commands.find((c) => !SETUP.has(programName(c.words.find((w) => !ASSIGNMENT.test(w)) ?? ''))) ??
    commands[0];
  if (!chosen) return null;
  const words = chosen.words.slice(chosen.words.findIndex((w) => !ASSIGNMENT.test(w)));
  const [program] = words;
  if (!program || chosen.words.every((w) => ASSIGNMENT.test(w)) || secretShaped(program))
    return null;
  const named = chosen.summary?.split(' ') ?? [];
  const prefix = [program];
  if (named[0] === program)
    for (let i = 1; i < named.length && named[i] === words[i]; i++) prefix.push(words[i] as string);
  return {
    words: prefix,
    danger: commandDanger(
      prefix,
      commands.map((c) => c.words),
    ),
  };
}

function commandDanger(prefix: string[], commands: string[][]): DangerKind | null {
  const [program = '', sub] = prefix.map(programName);
  if (ADMIN.has(program)) return 'sudo';
  if (DELETES.has(program) || (program === 'git' && sub === 'clean')) return 'delete';
  if (program === 'git' && (sub === undefined || sub === 'push')) return 'force-push';
  if (RUNS_ANY.has(program)) return 'shell';
  const programs = commands.map((words) =>
    programName(words.find((w) => !ASSIGNMENT.test(w)) ?? ''),
  );
  const fetchAt = programs.findIndex((p) => FETCHES.has(p));
  if (fetchAt >= 0 && programs.slice(fetchAt + 1).some((p) => SHELL_PROGRAMS.has(p)))
    return 'pipe-to-shell';
  return null;
}

/** A path with `/` separators, `.` and `..` resolved; absolute when it starts with `/` or a drive. */
function normalize(path: string): string {
  const p = path.replace(/\\/g, '/');
  const rooted = p.startsWith('/');
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length > 0 && out.at(-1) !== '..') out.pop();
    else if (part !== '..' || !rooted) out.push(part);
  }
  return (rooted ? '/' : '') + out.join('/');
}

const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:\//.test(p);

/** `path` relative to `dir` when it is `dir` or inside it ('' for `dir` itself), else null. */
function inside(dir: string, path: string): string | null {
  const d = normalize(dir);
  if (path === d) return '';
  const base = d.endsWith('/') ? d : `${d}/`;
  return path.startsWith(base) ? path.slice(base.length) : null;
}

const parentOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), 0)) || '/';

/**
 * The rule for a file call: `<Tool>(<first segment>/**)`, or the file, inside the session's
 * directory (none for a read there: reads inside it are never asked); outside it the file's
 * directory, under home as `~/…`, else from the root as `//…`; the file itself when that
 * directory is home or the root. `dir` says the path names a directory (a search's), not a file.
 */
function fileKey(
  tool: 'Edit' | 'Read',
  path: string,
  place: SessionPlace,
  dir: boolean,
): RuleKey | null {
  const home = place.home ? normalize(place.home) : null;
  let p = normalize(path);
  if (home && (path === '~' || path.startsWith('~/'))) p = normalize(`${home}/${path.slice(1)}`);
  const abs = isAbsolute(p) ? p : place.cwd ? normalize(`${place.cwd}/${p}`) : null;
  const local = abs === null ? p : place.cwd ? inside(place.cwd, abs) : null;
  if (local !== null) {
    if (tool === 'Read') return null;
    const [first = '', ...rest] = local.split('/');
    return {
      key: `${tool}(${rest.length > 0 || dir ? `${first}/**` : first})`,
      tool,
      danger: null,
    };
  }
  const target = abs as string;
  const folder = dir ? target : parentOf(target);
  const underHome = home ? inside(home, folder) : null;
  const whole = (folder === home || folder === '/') && !dir;
  const spec =
    underHome !== null
      ? whole
        ? `~/${target.slice((home as string).length + 1)}`
        : `~/${underHome}/**`
      : whole
        ? `/${target}`
        : `/${folder}/**`;
  const tree = place.tree ?? place.cwd;
  const outside = tool === 'Edit' && !(tree && inside(tree, target) !== null);
  return { key: `${tool}(${spec})`, tool, danger: outside ? 'outside' : null };
}

/**
 * The rule a call would need, or null when no rule decides it: see the module's comment. Codex's
 * rule is its `prefix_rule` whatever the call asked; whether the call counts is
 * `permissionEvents`' to say.
 */
export function ruleKeyOf(
  agent: AgentKind,
  name: string,
  input: unknown,
  place: SessionPlace,
): RuleKey | null {
  if (agent === 'codex') {
    if (name === CODEX_PATCH) return { key: CODEX_PATCH, tool: CODEX_PATCH, danger: null };
    if (!SHELLS.has(name)) return null;
    const command = shellCommand(input);
    const prefix = command === null ? null : commandPrefix(command);
    if (!prefix) return null;
    const pattern = prefix.words.map((w) => JSON.stringify(w)).join(', ');
    return { key: `prefix_rule(pattern=[${pattern}])`, tool: 'prefix_rule', danger: prefix.danger };
  }
  if (agent !== 'claude-code') return null;
  if (name === 'Bash') {
    const command = shellCommand(input);
    const prefix = command === null ? null : commandPrefix(command);
    return (
      prefix && { key: `Bash(${prefix.words.join(' ')}:*)`, tool: 'Bash', danger: prefix.danger }
    );
  }
  if (FILE_EDITS.has(name) || FILE_READS.has(name)) {
    const path = pathField(input);
    if (!path) return null;
    return fileKey(
      FILE_EDITS.has(name) ? 'Edit' : 'Read',
      path,
      place,
      name !== 'Read' && !FILE_EDITS.has(name),
    );
  }
  if (name === 'WebFetch') {
    const url =
      typeof (input as { url?: unknown } | null)?.url === 'string'
        ? (input as { url: string }).url
        : '';
    const host = hostOf(url)?.replace(/:\d+$/, '');
    return {
      key: host && !host.includes('…') ? `WebFetch(domain:${host})` : 'WebFetch',
      tool: 'WebFetch',
      danger: null,
    };
  }
  const mcp = name.startsWith('mcp__') ? mcpTool(name) : null;
  if (mcp) return { key: name, tool: `mcp__${mcp.server}`, danger: null };
  if (OTHER_RULES.has(name)) return { key: name, tool: name, danger: null };
  return null;
}

// --- answers -------------------------------------------------------------------------------

/** Claude Code's result for a prompt the person declined, with or without a reason. */
const DECLINED = "The user doesn't want to proceed with this tool use.";
/** What a glassbox run tells Claude Code when the person denies without a reason. */
const DECLINED_IN_GLASSBOX = 'The user declined this action.';
/** Refusals no person made: a deny rule, the auto-mode classifier, don't-ask mode. */
const REFUSED =
  /^Permission (?:to use [\s\S]*? has been denied|for this action (?:has been|was) denied)/;
/** A call stopped with the others when the person stopped the turn. */
const CANCELLED = "The user doesn't want to take this action right now.";
const CODEX_DECLINED = /^(?:\{"output":")?(?:exec command|patch) rejected by user/;

/**
 * How the prompt for `call` was answered, from its result: null when that cannot be told (no
 * result yet, a refusal no person made, a call stopped with the turn) or when it never reached a
 * prompt: a file tool's error comes from the checks made before one (a string not found, a file
 * not read first), while a command, a fetch or an MCP call that failed did run.
 */
export function answerOf(
  agent: AgentKind,
  call: Pick<ToolCall, 'name' | 'status' | 'resultPreview'>,
): PermissionAnswer | null {
  if (call.status === 'running' || call.status === 'unknown') return null;
  const text = (call.resultPreview ?? '').trimStart();
  if (agent === 'codex') return CODEX_DECLINED.test(text) ? 'denied' : 'allowed';
  if (call.status !== 'error') return 'allowed';
  if (text.startsWith(DECLINED) || text.trim() === DECLINED_IN_GLASSBOX) return 'denied';
  if (REFUSED.test(text) || text.startsWith(CANCELLED)) return null;
  return FILE_EDITS.has(call.name) || FILE_READS.has(call.name) ? null : 'allowed';
}

/** A Codex command that asked to run outside its sandbox: the person was asked. */
function escalated(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const o = input as Record<string, unknown>;
  return o.sandbox_permissions === 'require_escalated' || o.with_escalated_permissions === true;
}

/**
 * Every call of the session a rule decides, in the session's order. A glassbox run's answers
 * (`runDecisions`) win over what the transcript can tell: a deny with the person's own reason
 * reads there like any failed call. Codex's commands count when they asked to leave the sandbox
 * or were refused, its patches when refused: the rest ran in the sandbox without asking.
 */
export function permissionEvents(
  snapshot: SessionSnapshot,
  place: SessionPlace,
  decisions: ReadonlyMap<string, 'allow' | 'deny'> = new Map(),
): PermissionEvent[] {
  const { agent } = snapshot.session;
  if (agent !== 'claude-code' && agent !== 'codex') return [];
  const requestStart = new Map(snapshot.requests.map((r) => [r.id, r.startedAt]));
  const events: PermissionEvent[] = [];
  for (const call of snapshot.toolCalls) {
    const rule = ruleKeyOf(agent, call.name, call.input, place);
    if (!rule) continue;
    const decided = decisions.get(call.id);
    const answer = decided ? (decided === 'deny' ? 'denied' : 'allowed') : answerOf(agent, call);
    if (!answer) continue;
    if (
      agent === 'codex' &&
      answer === 'allowed' &&
      !(SHELLS.has(call.name) && escalated(call.input))
    )
      continue;
    const at = call.startedAt ?? requestStart.get(call.requestId) ?? null;
    if (!at) continue;
    events.push({ ...rule, agent, answer, at, toolCallId: call.id });
  }
  return events;
}

/** The prompts glassbox runs answered, by tool-use id; a withdrawn one was never answered. */
export function runDecisions(runs: readonly RunState[]): Map<string, 'allow' | 'deny'> {
  const out = new Map<string, 'allow' | 'deny'>();
  for (const run of runs)
    for (const d of run.decidedPermissions ?? [])
      if (d.decision !== 'cancelled') out.set(d.id, d.decision);
  return out;
}
