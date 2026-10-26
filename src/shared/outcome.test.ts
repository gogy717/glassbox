import { beforeEach, describe, expect, it } from 'vitest';
import type { ModelRequest, ToolCall } from '../core/model.js';
import {
  commitMessage,
  isTestRun,
  type OutcomeSource,
  sessionOutcome,
  testVerdict,
} from './outcome.js';

const CWD = '/w/app';
const MAIN: ReadonlySet<string> = new Set(['main']);

let serial = 0;
beforeEach(() => {
  serial = 0;
});
const at = (sec: number) => new Date(Date.UTC(2026, 9, 23, 9, 0, sec)).toISOString();

/** A finished call of the main agent, a second after the one before it. */
function call(name: string, input: unknown, over: Partial<ToolCall> = {}): ToolCall {
  serial++;
  return {
    id: `t_${serial}`,
    agentId: 'main',
    requestId: 'r1',
    name,
    input,
    status: 'complete',
    startedAt: at(serial),
    endedAt: at(serial),
    durationMs: 10,
    resultPreview: null,
    hasFullResult: false,
    spawned: null,
    ...over,
  };
}

const bash = (command: string, over: Partial<ToolCall> = {}) => call('Bash', { command }, over);

function request(over: Partial<ModelRequest> = {}): ModelRequest {
  serial++;
  return {
    id: `r_${serial}`,
    agentId: 'main',
    turnId: 'turn1',
    index: serial,
    model: 'claude-opus-5-5',
    effort: null,
    startedAt: at(serial),
    firstBlockAt: null,
    endedAt: at(serial),
    status: 'complete',
    stopReason: 'end_turn',
    usage: null,
    blocks: [],
    toolCallIds: [],
    hasDetail: false,
    error: null,
    ...over,
  };
}

const source = (calls: ToolCall[], requests: ModelRequest[] = []): OutcomeSource => ({
  session: { cwd: CWD },
  toolCalls: new Map(calls.map((c) => [c.id, c])),
  requests: new Map(requests.map((r) => [r.id, r])),
});

describe('isTestRun', () => {
  it.each([
    'npm test',
    'npm t',
    'npm run test',
    'npm run test:unit',
    'npm run check',
    'npx vitest run src/a.test.ts',
    'vitest',
    'jest --watch=false',
    'pytest -q tests',
    'python -m pytest -x',
    'python3 -m pytest',
    'uv run pytest',
    'go test ./...',
    'cargo test --all',
    'mvn test',
    'gradle test',
    './gradlew :app:test',
    'rspec spec/a_spec.rb',
    'bundle exec rspec',
    'vendor/bin/phpunit',
    'dotnet test',
    'make test',
    'bun test',
    'pnpm test',
    'yarn test',
    'pnpm run test:e2e',
    'yarn test:unit',
    // Wherever it runs in the line, however it is set up.
    'CI=1 npm test',
    'cd web && npm test 2>&1 | tail -20',
    'npm run build && npm test',
    'timeout 600 npm test',
  ])('%j runs tests', (command) => {
    expect(isTestRun(bash(command))).toBe(true);
  });

  it.each([
    'npm run build',
    'npm install',
    'git commit -m "npm test passes"',
    'echo npm test',
    'rg -n "test" src',
    'make build',
    'go build ./...',
    'npm run typecheck',
  ])('%j does not', (command) => {
    expect(isTestRun(bash(command))).toBe(false);
  });

  it('reads every agent’s shell, and no other tool', () => {
    expect(isTestRun(call('shell', { command: ['bash', '-lc', 'cargo test'] }))).toBe(true);
    expect(isTestRun(call('exec_command', { cmd: 'pytest' }))).toBe(true);
    expect(isTestRun(call('bash', { command: 'go test ./...' }))).toBe(true);
    expect(isTestRun(call('run_terminal_command', { command: 'npm test' }))).toBe(true);
    expect(isTestRun(call('execute_command', { command: 'npm test' }))).toBe(true);
    expect(isTestRun(call('Read', { file_path: 'npm test' }))).toBe(false);
  });
});

describe('testVerdict', () => {
  const run = (preview: string | null, over: Partial<ToolCall> = {}) =>
    testVerdict(bash('npm test', { resultPreview: preview, ...over }));

  it('is failed when the call failed, whatever its output', () => {
    expect(run('5 passed', { status: 'error' })).toBe('failed');
  });

  it('reads a failure in the output before a pass', () => {
    expect(run(' Test Files  1 failed | 3 passed (4)')).toBe('failed');
    expect(run('FAIL src/a.test.ts > adds')).toBe('failed');
    expect(run('✖ 1 test failed')).toBe('failed');
    expect(run('Error: Cannot find module "x"')).toBe('failed');
    expect(run('--- FAIL: TestParse (0.00s)')).toBe('failed');
  });

  it('reads a pass, and a zero count of failures as none', () => {
    expect(run('Tests  4501 passed (4501)')).toBe('passed');
    expect(run('ok  \tgithub.com/x/app\t0.02s')).toBe('passed');
    expect(run(' ✓ src/a.test.ts (3 tests) 4ms')).toBe('passed');
    expect(run('test result: ok. 12 passed; 0 failed; 0 ignored')).toBe('passed');
  });

  it('is unknown when the output says neither, and running while it runs', () => {
    expect(run('> app@1.0.0 test')).toBe('unknown');
    expect(run(null)).toBe('unknown');
    expect(run(null, { status: 'running', endedAt: null })).toBe('running');
  });
});

describe('commitMessage', () => {
  const commit = (command: string) => commitMessage(bash(command));

  it('is the first line of the -m message, wherever the commit is in the line', () => {
    expect(commit('git commit -m "Fix the parser"')).toBe('Fix the parser');
    expect(commit('git add -A && git -C repo commit -am "Fix it" && git push')).toBe('Fix it');
    expect(commit('git commit --message="One\n\nTwo"')).toBe('One');
    expect(commit('git commit -m"Attached"')).toBe('Attached');
  });

  it('reads the message a heredoc gives, as Claude Code writes its commits', () => {
    expect(
      commit(
        'git commit -m "$(cat <<\'EOF\'\nThe receipt prints test runs\n\nWhy, at length.\nEOF\n)"',
      ),
    ).toBe('The receipt prints test runs');
  });

  it('is null for a commit without one, and undefined for what is not a commit', () => {
    expect(commit('git commit --amend --no-edit')).toBeNull();
    expect(commit('git log -1')).toBeUndefined();
    expect(commit('echo git commit')).toBeUndefined();
    expect(commitMessage(call('Read', { file_path: 'a' }))).toBeUndefined();
  });
});

describe('sessionOutcome', () => {
  it('counts files as the Files tab does: each file once a verb', () => {
    const o = sessionOutcome(
      source([
        call('Edit', { file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' }),
        call('Edit', { file_path: 'a.ts', old_string: 'b', new_string: 'c' }),
        call('Write', { file_path: `${CWD}/b.ts`, content: 'x' }),
        call('Delete', { path: `${CWD}/c.ts` }),
        call('Read', { file_path: `${CWD}/d.ts` }),
      ]),
      MAIN,
    );
    expect(o.files).toEqual({ edited: 1, created: 1, deleted: 1 });
  });

  it('counts test runs and keeps the last one’s verdict', () => {
    const first = bash('npm test', { resultPreview: '1 failed', status: 'error' });
    const last = bash('npx vitest run', { resultPreview: '12 passed' });
    const o = sessionOutcome(source([last, bash('npm run build'), first]), MAIN);
    expect(o.tests).toEqual({ runs: 2, last, verdict: 'passed' });
  });

  it('counts the commits that went through, with the last one’s message', () => {
    const first = bash('git commit -m "First"');
    // A hook refused it: nothing was committed.
    const refused = bash('git commit -m "Refused"', { status: 'error' });
    const last = bash('git commit -m "Second"');
    const o = sessionOutcome(source([last, refused, first]), MAIN);
    expect(o.commits).toEqual({ count: 2, last, message: 'Second' });
  });

  it('counts the questions asked, and the last', () => {
    const first = call('request_user_input', { q: 'A?' });
    const last = call('AskUserQuestion', { questions: [{ question: 'B?' }] });
    const o = sessionOutcome(source([last, first]), MAIN);
    expect(o.questions).toEqual({ count: 2, last });
  });

  it('counts failed tool calls and failed requests, and finds the first', () => {
    const failedTool = bash('false', { status: 'error' });
    const failedRequest = request({ status: 'error' });
    const o = sessionOutcome(source([bash('true'), failedTool], [failedRequest, request()]), MAIN);
    expect(o.failures).toEqual({ count: 2, first: { kind: 'tool', tool: failedTool } });
  });

  it('reads the given agents only, and has nothing to say about a session that did nothing', () => {
    const o = sessionOutcome(
      source(
        [
          bash('npm test', { agentId: 'sub' }),
          call('Write', { file_path: `${CWD}/b.ts`, content: 'x' }, { agentId: 'sub' }),
          bash('ls'),
        ],
        [request({ agentId: 'sub', status: 'error' })],
      ),
      MAIN,
    );
    expect(o).toEqual({
      files: { edited: 0, created: 0, deleted: 0 },
      tests: null,
      commits: null,
      questions: null,
      failures: null,
    });
  });
});
