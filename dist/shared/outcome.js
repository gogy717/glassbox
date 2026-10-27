/**
 * What a session's agents did, the first question after it ran: the files they edited, created
 * and deleted (as the Files tab counts them), the tests they ran and how the last run went, the
 * commits they made, the questions they asked and what failed. Read from tool calls and model
 * calls alone, for any set of agents: the outcome strip's model, and the receipt's.
 */
import { simpleCommands } from '../core/command-summary.js';
import { buildFiles } from './files.js';
import { SHELL_TOOLS, shellCommand, toolCategory } from './tool-category.js';
/**
 * Each call's commands, read once: a session holds thousands of shell calls, the strip reads
 * them again on every patch, and a patch keeps the calls it does not change.
 */
const read = new WeakMap();
/** The simple commands a shell call runs, each with its summary; none for another tool. */
function commandsOf(tool) {
    if (!SHELL_TOOLS.has(tool.name))
        return [];
    let commands = read.get(tool);
    if (!commands) {
        const line = shellCommand(tool.input);
        commands =
            line === null ? [] : simpleCommands(line, { powershell: /powershell|pwsh/i.test(tool.name) });
        read.set(tool, commands);
    }
    return commands;
}
/**
 * A command that runs tests, by its summary (wrappers, variables and options already left out):
 * a package script (`npm test`, `npm run test:unit`, `npm run check`), a runner (`vitest`,
 * `pytest`, `rspec`, `phpunit`, as `npx vitest`, `yarn jest`, `uv run pytest`, `bundle exec
 * rspec` or `python -m pytest` too) or a build tool's test task (`go test`, `cargo test`, `mvn
 * test`, `./gradlew :app:test`, `dotnet test`, `make test`, `bun test`, `deno test`).
 */
const TEST_COMMAND = new RegExp([
    '^(?:(?:npx|pnpx|bunx|(?:uv|poetry|pipenv|pdm|hatch) run|bundle exec|(?:npm|pnpm|yarn) (?:exec|dlx)|python[\\d.]* -m|py -m) )*',
    '(?:vitest|jest|mocha|pytest|py\\.test|rspec|phpunit',
    '|(?:npm|pnpm|yarn|bun) (?:t|tst|test(?::\\S+)?|run(?:-script)? (?:test\\S*|check))',
    '|(?:pnpm|yarn) (?:test\\S*|vitest|jest|mocha)',
    '|(?:go|cargo|mvnw?|gradlew?|dotnet|make|deno|bun) (?:\\S+:)?test',
    ')(?: |$)',
].join(''));
/** Build tools whose test task can follow options the summary does not read (`mvn -q test`). */
const BUILD_TOOL = /(?:^|[\\/])(?:mvnw?|gradlew?)(?:\.cmd|\.bat)?$/;
/**
 * What the summary leaves out: a build tool's `test` task past its options, and Playwright's
 * runner, which `npx playwright test` sums up as `npx playwright`.
 */
function wordsRunTests(words) {
    const at = words.findIndex((w) => !/^\w+=/.test(w));
    if (BUILD_TOOL.test(words[at] ?? ''))
        return words.slice(at + 1).some((w) => w === 'test' || w.endsWith(':test'));
    const pw = words.indexOf('playwright');
    return pw !== -1 && words[pw + 1] === 'test';
}
/** Whether a shell call runs a test runner, wherever in its line. */
export function isTestRun(tool) {
    return commandsOf(tool).some((c) => (c.summary !== null && TEST_COMMAND.test(c.summary)) || wordsRunTests(c.words));
}
/**
 * Each mention of the words with its count, as "3 failed", "0 tests failed" or "Failed: 3"; NaN
 * when it has none.
 */
function counted(text, words) {
    const out = [];
    const noun = '(?:(?:tests?|specs?|examples?|cases?|suites?|files?)\\s+)?';
    const re = new RegExp(`(?:\\b(\\d+)\\s+${noun})?\\b(?:${words})\\b(?:!|:?\\s*(\\d+))?`, 'gi');
    for (const m of text.matchAll(re))
        out.push((m[1] ?? m[2]) ? Number(m[1] ?? m[2]) : Number.NaN);
    return out;
}
/**
 * What the start of a run's output says: first its counts ("1 failed | 3 passed", "5 examples, 0
 * failures"), which no test's name or stray stderr line outweighs; without any, a runner's
 * marks and words, a failure before a pass (✗ × FAIL, then ✓ PASS, then an Error, "failed",
 * "ok", "passed").
 */
function outputVerdict(text) {
    const failures = counted(text, 'failed|failing|failures?|errors?');
    const passes = counted(text, 'passed|passing');
    if (failures.some((n) => n > 0))
        return 'failed';
    if (passes.some((n) => n > 0))
        return 'passed';
    // None failed, said so, and not because none ran.
    if (failures.length > 0 && failures.every((n) => n === 0) && !passes.includes(0))
        return 'passed';
    if (/(?:^|\s)[✖✗✕×](?=\s|$)/m.test(text) || /\bFAIL(?:ED|URES?)?\b/.test(text))
        return 'failed';
    if (/[✓✔]/.test(text) || /\bPASS(?:ED)?\b/.test(text))
        return 'passed';
    if (/\b\w*Error\b/.test(text) || counted(text, 'failed|failing').some(Number.isNaN))
        return 'failed';
    if (/\bok\b/i.test(text) || passes.some(Number.isNaN))
        return 'passed';
    return 'unknown';
}
/**
 * A test run's verdict: failed when its call failed; else what the start of its output says
 * (`outputVerdict`); else unknown. Running while it runs.
 */
export function testVerdict(tool) {
    if (tool.status === 'error')
        return 'failed';
    if (tool.status === 'running')
        return 'running';
    return outputVerdict(tool.resultPreview ?? '');
}
/** The line git prints for a commit it made: `[main 1a2b3c4] Fix it`, `[main (root-commit) …]`. */
const COMMITTED = /^\[[^\]\n]*\b[0-9a-f]{7,40}\] /m;
/** A message as `cat <<'EOF' … EOF` gives it inside `$(…)`: the heredoc's body. */
const HEREDOC = /^\$\(\s*cat\s+<<-?\s*(['"]?)(\w+)\1[ \t]*\n([\s\S]*?)\n\s*\2\s*\)\s*$/;
/** The first line of a message with something on it, null when there is none. */
function firstLine(message) {
    if (message === undefined)
        return null;
    const body = HEREDOC.exec(message.trim())?.[3] ?? message;
    return (body
        .split('\n')
        .find((l) => l.trim() !== '')
        ?.trim() ?? null);
}
/** `git … commit`'s message: `-m msg`, `-mmsg`, `-am msg`, `--message msg` or `--message=msg`. */
function messageOf(words) {
    const from = words.indexOf('commit');
    if (from === -1)
        return null;
    for (let i = from + 1; i < words.length; i++) {
        const w = words[i];
        if (w === '--')
            break;
        if (w === '--message')
            return firstLine(words[i + 1]);
        if (w.startsWith('--message='))
            return firstLine(w.slice('--message='.length));
        // Short options run together, the message attached or next: -m, -am, -mText.
        const short = /^-[A-Za-z]*?m([\s\S]*)$/.exec(w);
        if (short)
            return firstLine(short[1] || words[i + 1]);
    }
    return null;
}
/**
 * A shell call's commit message, the first line of what `-m` gives (a heredoc's too); null for a
 * commit without one, undefined when the call commits nothing.
 */
export function commitMessage(tool) {
    const commit = commandsOf(tool).find((c) => c.summary?.startsWith('git commit'));
    return commit ? messageOf(commit.words) : undefined;
}
const ms = (iso) => (iso === null ? Number.NaN : Date.parse(iso));
/** When a call started, or ended when its start is unknown; NaN when neither is. */
const startOf = (x) => ms(x.startedAt ?? x.endedAt);
/** Whether `a` came after `b`; a time not known counts as before every known one. */
const after = (a, b) => !Number.isNaN(a) && (Number.isNaN(b) || a > b);
/** `kept` with `tool` counted in; the later of the two is the last. */
const tally = (kept, tool) => kept
    ? { count: kept.count + 1, last: after(startOf(kept.last), startOf(tool)) ? kept.last : tool }
    : { count: 1, last: tool };
/** `kept` with one more failure counted in; the earlier of the two is the first. */
const failure = (kept, first, at) => kept
    ? after(kept.at, at)
        ? { count: kept.count + 1, first, at }
        : { ...kept, count: kept.count + 1 }
    : { count: 1, first, at };
/** What the given agents did in a session, from its tool calls and model calls. */
export function sessionOutcome(open, agentIds) {
    const { summary } = buildFiles(open, agentIds);
    let tests = null;
    let commits = null;
    let questions = null;
    let failures = null;
    for (const tool of open.toolCalls.values()) {
        if (!agentIds.has(tool.agentId))
            continue;
        if (tool.status === 'error')
            failures = failure(failures, { kind: 'tool', tool }, startOf(tool));
        if (isTestRun(tool))
            tests = tally(tests, tool);
        // A commit a hook refused, or one with nothing to commit, committed nothing; one whose push
        // was refused did, and git said so first.
        const committed = tool.status !== 'error' || COMMITTED.test(tool.resultPreview ?? '');
        if (committed && commitMessage(tool) !== undefined)
            commits = tally(commits, tool);
        // A shell call is never a question, and reading its line to say so costs.
        if (!SHELL_TOOLS.has(tool.name) && toolCategory(tool.name, tool.input) === 'ask')
            questions = tally(questions, tool);
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
//# sourceMappingURL=outcome.js.map