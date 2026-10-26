/**
 * What a session's agents did, the first question after it ran: the files they edited, created
 * and deleted (as the Files tab counts them), the tests they ran and how the last run went, the
 * commits they made, the questions they asked and what failed. Read from tool calls and model
 * calls alone, for any set of agents: the outcome strip's model, and the receipt's.
 */
import { simpleCommands } from '../core/command-summary.js';
import type { IsoTime, ModelRequest, ToolCall } from '../core/model.js';
import { buildFiles, type FilesSource } from './files.js';
import { SHELLS, shellCommand, toolCategory } from './tool-category.js';

/** How a test run went: by its call's status, else by what its output says. */
export type TestVerdict = 'passed' | 'failed' | 'running' | 'unknown';

export type Failure = { kind: 'tool'; tool: ToolCall } | { kind: 'request'; request: ModelRequest };

export interface Outcome {
  /** Files edited, created and deleted: each file once a verb, finished calls only. */
  files: { edited: number; created: number; deleted: number };
  /** Null when no test ran. */
  tests: { runs: number; last: ToolCall; verdict: TestVerdict } | null;
  /** The commits that went through; the last one's message, its first line, when it gave one. */
  commits: { count: number; last: ToolCall; message: string | null } | null;
  questions: { count: number; last: ToolCall } | null;
  /** Failed tool calls and failed model calls, and the first of them. */
  failures: { count: number; first: Failure } | null;
}

export interface OutcomeSource extends FilesSource {
  requests: ReadonlyMap<string, ModelRequest>;
}

/** Shell tools of every agent glassbox reads, and of the agents that call theirs so. */
const SHELL_TOOLS = new Set([...SHELLS, 'execute_command']);

/** The simple commands a shell call runs, each with its summary; none for another tool. */
function commandsOf(tool: ToolCall): { words: string[]; summary: string | null }[] {
  if (!SHELL_TOOLS.has(tool.name)) return [];
  const line = shellCommand(tool.input);
  return line === null
    ? []
    : simpleCommands(line, { powershell: /powershell|pwsh/i.test(tool.name) });
}

/**
 * A command that runs tests, by its summary (wrappers, variables and options already left out):
 * a package script (`npm test`, `npm run test:unit`, `npm run check`), a runner (`vitest`,
 * `pytest`, `rspec`, `phpunit`, as `npx vitest`, `uv run pytest`, `bundle exec rspec` or
 * `python -m pytest` too) or a build tool's test task (`go test`, `cargo test`, `mvn test`,
 * `./gradlew :app:test`, `dotnet test`, `make test`, `bun test`, `deno test`).
 */
const TEST_COMMAND = new RegExp(
  [
    '^(?:(?:npx|pnpx|bunx|(?:uv|poetry|pipenv|pdm|hatch) run|bundle exec|(?:npm|pnpm|yarn) (?:exec|dlx)|python[\\d.]* -m|py -m) )*',
    '(?:vitest|jest|mocha|pytest|py\\.test|rspec|phpunit',
    '|(?:npm|pnpm|yarn|bun) (?:t|tst|test(?::\\S+)?|run(?:-script)? (?:test\\S*|check))',
    '|(?:pnpm|yarn) test\\S*',
    '|(?:go|cargo|mvnw?|gradlew?|dotnet|make|deno|bun|playwright) (?:\\S+:)?test',
    ')(?: |$)',
  ].join(''),
);

/** Whether a shell call runs a test runner, wherever in its line. */
export function isTestRun(tool: ToolCall): boolean {
  return commandsOf(tool).some((c) => c.summary !== null && TEST_COMMAND.test(c.summary));
}

/** Each mention of the words with its count, as "3 failed" or "Failed: 3"; NaN when it has none. */
function counted(text: string, words: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`(?:\\b(\\d+)\\s+)?\\b(?:${words})\\b(?:!|:?\\s*(\\d+))?`, 'gi');
  for (const m of text.matchAll(re)) out.push((m[1] ?? m[2]) ? Number(m[1] ?? m[2]) : Number.NaN);
  return out;
}

/** A failure the output names: a mark, FAIL, an error, a count of failures that is not 0. */
function saysFailed(text: string): boolean {
  if (/[✖✗✕]/.test(text) || /\bFAIL(?:ED|URES?)?\b/.test(text) || /\b\w*Error\b/.test(text))
    return true;
  // "failed" said without a count is a failure; "0 failed" or "Failures: 0" is not.
  return counted(text, 'failed|failing|failures?').some((n) => n !== 0);
}

function saysPassed(text: string): boolean {
  if (/[✓✔]/.test(text) || /\bok\b/i.test(text)) return true;
  return counted(text, 'passed|passing').some((n) => n !== 0);
}

/**
 * A test run's verdict: failed when its call failed; else what the start of its output says, a
 * failure before a pass ("1 failed | 3 passed"); else unknown. Running while it runs.
 */
export function testVerdict(tool: ToolCall): TestVerdict {
  if (tool.status === 'error') return 'failed';
  if (tool.status === 'running') return 'running';
  const text = tool.resultPreview ?? '';
  if (saysFailed(text)) return 'failed';
  if (saysPassed(text)) return 'passed';
  return 'unknown';
}

/** A message as `cat <<'EOF' … EOF` gives it inside `$(…)`: the heredoc's body. */
const HEREDOC = /^\$\(\s*cat\s+<<-?\s*(['"]?)(\w+)\1[ \t]*\n([\s\S]*?)\n\s*\2\s*\)\s*$/;

/** The first line of a message with something on it, null when there is none. */
function firstLine(message: string | undefined): string | null {
  if (message === undefined) return null;
  const body = HEREDOC.exec(message.trim())?.[3] ?? message;
  return (
    body
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? null
  );
}

/** `git … commit`'s message: `-m msg`, `-mmsg`, `-am msg`, `--message msg` or `--message=msg`. */
function messageOf(words: string[]): string | null {
  const from = words.indexOf('commit');
  if (from === -1) return null;
  for (let i = from + 1; i < words.length; i++) {
    const w = words[i] as string;
    if (w === '--') break;
    if (w === '--message') return firstLine(words[i + 1]);
    if (w.startsWith('--message=')) return firstLine(w.slice('--message='.length));
    // Short options run together, the message attached or next: -m, -am, -mText.
    const short = /^-[A-Za-z]*?m([\s\S]*)$/.exec(w);
    if (short) return firstLine(short[1] || words[i + 1]);
  }
  return null;
}

/**
 * A shell call's commit message, the first line of what `-m` gives (a heredoc's too); null for a
 * commit without one, undefined when the call commits nothing.
 */
export function commitMessage(tool: ToolCall): string | null | undefined {
  const commit = commandsOf(tool).find((c) => c.summary?.startsWith('git commit'));
  return commit ? messageOf(commit.words) : undefined;
}

const ms = (iso: IsoTime | null) => (iso === null ? Number.NaN : Date.parse(iso));
/** When a call started, or ended when its start is unknown; NaN when neither is. */
const startOf = (x: { startedAt: IsoTime | null; endedAt: IsoTime | null }) =>
  ms(x.startedAt ?? x.endedAt);
/** Whether `a` came after `b`; a time not known counts as before every known one. */
const after = (a: number, b: number) => !Number.isNaN(a) && (Number.isNaN(b) || a > b);

interface Tally {
  count: number;
  last: ToolCall;
}

/** `kept` with `tool` counted in; the later of the two is the last. */
const tally = (kept: Tally | null, tool: ToolCall): Tally =>
  kept
    ? { count: kept.count + 1, last: after(startOf(kept.last), startOf(tool)) ? kept.last : tool }
    : { count: 1, last: tool };

interface Failures {
  count: number;
  first: Failure;
  at: number;
}

/** `kept` with one more failure counted in; the earlier of the two is the first. */
const failure = (kept: Failures | null, first: Failure, at: number): Failures =>
  kept
    ? after(kept.at, at)
      ? { count: kept.count + 1, first, at }
      : { ...kept, count: kept.count + 1 }
    : { count: 1, first, at };

/** What the given agents did in a session, from its tool calls and model calls. */
export function sessionOutcome(open: OutcomeSource, agentIds: ReadonlySet<string>): Outcome {
  const { summary } = buildFiles(open, agentIds);
  let tests: Tally | null = null;
  let commits: Tally | null = null;
  let questions: Tally | null = null;
  let failures: Failures | null = null;
  for (const tool of open.toolCalls.values()) {
    if (!agentIds.has(tool.agentId)) continue;
    if (tool.status === 'error')
      failures = failure(failures, { kind: 'tool', tool }, startOf(tool));
    if (isTestRun(tool)) tests = tally(tests, tool);
    // A commit a hook refused, or one with nothing to commit, committed nothing.
    if (tool.status !== 'error' && commitMessage(tool) !== undefined)
      commits = tally(commits, tool);
    if (toolCategory(tool.name, tool.input) === 'ask') questions = tally(questions, tool);
  }
  for (const request of open.requests.values())
    if (agentIds.has(request.agentId) && request.status === 'error')
      failures = failure(failures, { kind: 'request', request }, startOf(request));

  return {
    files: { edited: summary.edited, created: summary.created, deleted: summary.deleted },
    tests: tests && { runs: tests.count, last: tests.last, verdict: testVerdict(tests.last) },
    commits: commits && { ...commits, message: commitMessage(commits.last) ?? null },
    questions,
    failures: failures && { count: failures.count, first: failures.first },
  };
}
