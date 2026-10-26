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
/**
 * Programs that run whatever command they are given, and the shell's own words that do (a rule
 * for `for` allows every loop, whatever it runs).
 */
const RUNS_ANY = new Set([
  'for',
  'while',
  'until',
  'if',
  'case',
  'select',
  'function',
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

// --- the rule table ------------------------------------------------------------------------

/**
 * `GET /api/rules?window=7d|30d|all[&refresh=1]`: every session of the window read once and
 * kept, as the weekly receipt's are (`src/shared/week.ts`), its permission events counted by
 * rule. The response is NDJSON: `progress` lines (`done` never goes down), then one `result`
 * line, or an `error` line.
 */
export type RulesWindowKind = '7d' | '30d' | 'all';

export const RULES_WINDOWS: readonly RulesWindowKind[] = ['7d', '30d', 'all'];

const DAY_MS = 86_400_000;

/** When a window begins (epoch ms): 7 or 30 days before `now`; null for all of it. */
export function rulesWindowStart(kind: RulesWindowKind, now: number): number | null {
  return kind === 'all' ? null : now - (kind === '7d' ? 7 : 30) * DAY_MS;
}

/** The endpoint's path for a window. */
export const rulesPath = (kind: RulesWindowKind, refresh = false) =>
  `/api/rules?window=${kind}${refresh ? '&refresh=1' : ''}`;

/**
 * Where sessions ran, as one: a repository's root, its worktrees included, or a directory in no
 * repository. `root` is null when the session named no directory.
 */
export interface RuleProject {
  root: string | null;
  /** As the session list names it. */
  name: string;
}

/** A session's permission events, and its project. */
export interface SessionEvents {
  sessionId: string;
  project: RuleProject;
  events: PermissionEvent[];
}

export interface RuleCounts {
  asked: number;
  allowed: number;
  denied: number;
  lastAsked: IsoTime;
}

/**
 * The permission lists of one Claude Code settings file, the only part of it glassbox reads:
 * the user's (`scope` 'global'), or a project's `.claude/settings.json` or `settings.local.json`
 * (a worktree's own included, under its repository's `root`).
 */
export interface SettingsFile {
  path: string;
  scope: 'global' | 'project';
  root: string | null;
  allow: string[];
  deny: string[];
}

/** A settings rule that holds a key: allows (or denies) at least all it does. */
export interface SettingsHit {
  path: string;
  scope: 'global' | 'project';
  root: string | null;
  list: 'allow' | 'deny';
  rule: string;
}

/** One rule, as asked for across the window. */
export interface RuleRow extends RuleKey, RuleCounts {
  agent: AgentKind;
  /** Sessions it was asked in. */
  sessions: number;
  /** Each project it was asked in, with its counts there, the most asked first. */
  projects: (RuleProject & RuleCounts)[];
  /** The settings rules that already hold it, allow lists first. */
  inSettings: SettingsHit[];
  /**
   * Asked `SUGGEST_AFTER` times or more and always allowed, harmless, and held by no deny rule
   * and no allow rule where it would go (`scopeOf`): a Claude Code rule worth adding.
   */
  suggested: boolean;
}

export interface RulesWindow {
  kind: RulesWindowKind;
  /** When it begins (epoch ms); null for all. */
  from: number | null;
  now: number;
}

/** As `WeekStats`: the sessions the window counts, read now or found as cached, and failed. */
export interface RulesStats {
  considered: number;
  read: number;
  cached: number;
  failed: number;
  ms: number;
}

export interface RulesResult {
  window: RulesWindow;
  /** The most asked first. */
  rows: RuleRow[];
  /** The settings files found, with their two lists: nothing else of them is read. */
  settings: SettingsFile[];
  /** Where your own settings are, whether the file is there or not; null when not known. */
  yourSettings: string | null;
  /** When it was put together (epoch ms). */
  asOf: number;
  stats: RulesStats;
}

export type RulesLine =
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; result: RulesResult }
  | { type: 'error'; error: string };

/** Times a rule is asked, and always allowed, before it is suggested. */
export const SUGGEST_AFTER = 5;

/** The gravest first: a rule keeps the gravest harm any of its calls showed. */
const GRAVITY: readonly DangerKind[] = [
  'sudo',
  'delete',
  'force-push',
  'shell',
  'pipe-to-shell',
  'outside',
];
const graver = (a: DangerKind | null, b: DangerKind | null) =>
  a === null ? b : b === null ? a : GRAVITY.indexOf(a) <= GRAVITY.indexOf(b) ? a : b;

const later = (a: IsoTime, b: IsoTime) => (Date.parse(b) > Date.parse(a) ? b : a);

/** A rule as its tool and its specifier: `Bash(npm test:*)` → Bash, `npm test:*`. */
function parseRule(rule: string): { tool: string; spec: string | null } | null {
  const m = /^([^()]+?)(?:\(([\s\S]*)\))?$/.exec(rule.trim());
  return m ? { tool: (m[1] as string).trim(), spec: m[2] ?? null } : null;
}

/** A Bash rule's prefix holds a key's at a word boundary; a command without `:*` only itself. */
function bashHolds(spec: string, keySpec: string): boolean {
  if (spec === '*') return true;
  const prefix = /^(.*?)(?::\*| \*)$/.exec(spec)?.[1]?.trim();
  if (prefix === undefined) return false;
  const key = keySpec.replace(/:\*$/, '');
  return key === prefix || key.startsWith(`${prefix} `);
}

/**
 * A path rule holds a key's pattern when equal, or when it ends in `/**` and its directory holds
 * the key's; `**` holds every pattern inside the directory (not `~/…` or `//…`). `./x` is `x`, and
 * a project's `/x` (from the settings file's directory) is taken as `x` too: the sessions it
 * counts ran there.
 */
function pathHolds(spec: string, keySpec: string): boolean {
  const plain = (s: string) => s.replace(/^\.\//, '').replace(/^\/(?!\/)/, '');
  const r = plain(spec);
  const k = plain(keySpec);
  if (r === k) return true;
  if (r === '**') return !k.startsWith('~/') && !k.startsWith('//');
  if (!r.endsWith('/**')) return false;
  const dir = r.slice(0, -3);
  return k === dir || k.startsWith(`${dir}/`);
}

/** Whether settings rule `rule` allows (or denies) at least everything key `key` would. */
export function holds(rule: string, key: string): boolean {
  if (rule.trim() === key) return true;
  const r = parseRule(rule);
  const k = parseRule(key);
  if (!r || !k) return false;
  const mcp = k.tool.startsWith('mcp__') ? mcpTool(k.tool) : null;
  if (mcp)
    return r.spec === null && [`mcp__${mcp.server}`, `mcp__${mcp.server}__*`].includes(r.tool);
  if (r.tool !== k.tool) return false;
  if (r.spec === null || r.spec === '*') return true;
  if (k.spec === null) return false;
  if (k.tool === 'Bash') return bashHolds(r.spec, k.spec);
  if (k.tool === 'Edit' || k.tool === 'Read') return pathHolds(r.spec, k.spec);
  return r.spec === k.spec;
}

/** Every rule of `settings` that holds `key`, file by file, allow lists first. */
function settingsHits(key: string, settings: readonly SettingsFile[]): SettingsHit[] {
  const hits: SettingsHit[] = [];
  for (const f of settings)
    for (const list of ['allow', 'deny'] as const)
      for (const rule of f[list])
        if (holds(rule, key)) hits.push({ path: f.path, scope: f.scope, root: f.root, list, rule });
  return hits;
}

/**
 * Where a rule's line goes: your own settings when it was asked in two projects or more (or in
 * none named), else the one project's.
 */
export function scopeOf(
  row: Pick<RuleRow, 'projects'>,
): { scope: 'global' } | { scope: 'project'; root: string; name: string } {
  const [only, ...more] = row.projects;
  return only && more.length === 0 && only.root !== null
    ? { scope: 'project', root: only.root, name: only.name }
    : { scope: 'global' };
}

function suggestedRow(row: Omit<RuleRow, 'suggested'>): boolean {
  if (row.agent !== 'claude-code' || row.asked < SUGGEST_AFTER || row.denied > 0) return false;
  if (row.danger !== null || row.inSettings.some((h) => h.list === 'deny')) return false;
  const where = scopeOf(row);
  return !row.inSettings.some(
    (h) =>
      h.list === 'allow' &&
      (h.scope === 'global' || (where.scope === 'project' && h.root === where.root)),
  );
}

const counts = (at: IsoTime): RuleCounts => ({ asked: 0, allowed: 0, denied: 0, lastAsked: at });
const count = (c: RuleCounts, e: PermissionEvent) => {
  c.asked++;
  if (e.answer === 'allowed') c.allowed++;
  else c.denied++;
  c.lastAsked = later(c.lastAsked, e.at);
};
const mostAsked = (a: RuleCounts, b: RuleCounts) =>
  b.asked - a.asked || Date.parse(b.lastAsked) - Date.parse(a.lastAsked);

/**
 * The rules asked since `from` (all when null), the most asked first: each with its counts, its
 * sessions and projects, the gravest harm its calls showed, the settings rules that hold it, and
 * whether it is suggested.
 */
export function ruleRows(
  sessions: readonly SessionEvents[],
  opts: { from: number | null; settings: readonly SettingsFile[] },
): RuleRow[] {
  const rows = new Map<
    string,
    Omit<RuleRow, 'sessions' | 'projects' | 'inSettings' | 'suggested'> & {
      sessionIds: Set<string>;
      byProject: Map<string, RuleProject & RuleCounts>;
    }
  >();
  for (const s of sessions) {
    for (const e of s.events) {
      if (opts.from !== null && !(Date.parse(e.at) >= opts.from)) continue;
      const id = `${e.agent}\n${e.key}`;
      let row = rows.get(id);
      if (!row) {
        row = {
          key: e.key,
          tool: e.tool,
          agent: e.agent,
          danger: null,
          ...counts(e.at),
          sessionIds: new Set(),
          byProject: new Map(),
        };
        rows.set(id, row);
      }
      count(row, e);
      row.danger = graver(row.danger, e.danger);
      row.sessionIds.add(s.sessionId);
      const projectId = s.project.root ?? `\n${s.project.name}`;
      let project = row.byProject.get(projectId);
      if (!project) {
        project = { ...s.project, ...counts(e.at) };
        row.byProject.set(projectId, project);
      }
      count(project, e);
    }
  }
  return [...rows.values()]
    .map(({ sessionIds, byProject, ...row }) => {
      const full = {
        ...row,
        sessions: sessionIds.size,
        projects: [...byProject.values()].sort(
          (a, b) => mostAsked(a, b) || a.name.localeCompare(b.name),
        ),
        inSettings: row.agent === 'claude-code' ? settingsHits(row.key, opts.settings) : [],
      };
      return { ...full, suggested: suggestedRow(full) };
    })
    .sort((a, b) => mostAsked(a, b) || a.key.localeCompare(b.key));
}
