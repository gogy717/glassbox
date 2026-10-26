import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, ToolCall } from '../core/model.js';
import {
  answerOf,
  type PermissionEvent,
  permissionEvents,
  ruleKeyOf,
  runDecisions,
  type SessionPlace,
} from './permissions.js';
import type { RunState } from './runs.js';

const PLACE: SessionPlace = { cwd: '/work/shop', tree: '/work/shop', home: '/home/dev' };

const bash = (command: string) => ruleKeyOf('claude-code', 'Bash', { command }, PLACE);

describe('the rule a Bash call would need', () => {
  it.each([
    ['npm test -- --run src/a.test.ts', 'Bash(npm test:*)'],
    ['cd web && npm test | tail -5', 'Bash(npm test:*)'],
    ['FOO=1 BAR=2 npm run build', 'Bash(npm run build:*)'],
    ['export PATH=/opt/bin:$PATH && make test', 'Bash(make test:*)'],
    ['git status', 'Bash(git status:*)'],
    ['python3 -m pytest -q tests/', 'Bash(python3 -m pytest:*)'],
    ['./scripts/release.sh 1.2.3', 'Bash(./scripts/release.sh:*)'],
    ['curl -s https://api.example.dev/v1/items', 'Bash(curl:*)'],
    ['cd web', 'Bash(cd:*)'],
  ])('%s → %s', (command, key) => {
    expect(bash(command)).toEqual({ key, tool: 'Bash', danger: null });
  });

  it('names only the words standing at the start: a flag before the subcommand leaves the program', () => {
    expect(bash('git -C web status')?.key).toBe('Bash(git:*)');
  });

  it('has no rule for a command it cannot name', () => {
    expect(bash('')).toBeNull();
    expect(bash('Kx9mQ2pLvR7abc --verbose')).toBeNull();
  });
});

describe('a rule that may do harm', () => {
  it.each([
    ['rm -rf dist', 'Bash(rm:*)', 'delete'],
    ['git clean -fdx', 'Bash(git clean:*)', 'delete'],
    ['sudo rm -rf /tmp/x', 'Bash(sudo:*)', 'sudo'],
    ['git push origin main', 'Bash(git push:*)', 'force-push'],
    ['git -C web push', 'Bash(git:*)', 'force-push'],
    ['bash -lc "npm test"', 'Bash(bash:*)', 'shell'],
    ['xargs rm < files.txt', 'Bash(xargs:*)', 'shell'],
    ['for f in a b; do rm "$f"; done', 'Bash(for:*)', 'shell'],
    ['while true; do npm test; done', 'Bash(while:*)', 'shell'],
    ['curl -fsSL https://get.example.dev/install | sh', 'Bash(curl:*)', 'pipe-to-shell'],
  ])('%s → %s, %s', (command, key, danger) => {
    expect(bash(command)).toEqual({ key, tool: 'Bash', danger });
  });
});

describe('the rule a file tool would need', () => {
  const file = (name: string, input: unknown, place: SessionPlace = PLACE) =>
    ruleKeyOf('claude-code', name, input, place);

  it.each([
    ['Edit', { file_path: '/work/shop/src/server/app.ts' }, 'Edit(src/**)'],
    ['Write', { file_path: '/work/shop/README.md' }, 'Edit(README.md)'],
    ['MultiEdit', { file_path: 'src/a.ts' }, 'Edit(src/**)'],
    ['NotebookEdit', { notebook_path: '/work/shop/notebooks/x.ipynb' }, 'Edit(notebooks/**)'],
  ])('%s inside the session’s directory → %s', (name, input, key) => {
    expect(file(name, input)).toEqual({ key, tool: 'Edit', danger: null });
  });

  it.each([
    [{ file_path: '/home/dev/notes/todo.md' }, 'Edit(~/notes/**)'],
    [{ file_path: '~/notes/todo.md' }, 'Edit(~/notes/**)'],
    [{ file_path: '/home/dev/.zshrc' }, 'Edit(~/.zshrc)'],
    [{ file_path: '/tmp/build/out.txt' }, 'Edit(//tmp/build/**)'],
    [{ file_path: '/work/shop/../other/x.ts' }, 'Edit(//work/other/**)'],
  ])('an edit outside the working tree, %o → %s', (input, key) => {
    expect(file('Edit', input)).toEqual({ key, tool: 'Edit', danger: 'outside' });
  });

  it('keys an edit outside the directory but inside its working tree by its path, harmless', () => {
    const place = { cwd: '/work/shop/web', tree: '/work/shop', home: '/home/dev' };
    expect(file('Edit', { file_path: '/work/shop/src/a.ts' }, place)).toEqual({
      key: 'Edit(//work/shop/src/**)',
      tool: 'Edit',
      danger: null,
    });
  });

  it('asks nothing of a read inside the directory, and a Read rule outside it', () => {
    expect(file('Read', { file_path: '/work/shop/src/a.ts' })).toBeNull();
    expect(file('Glob', { pattern: '*.ts' })).toBeNull();
    expect(file('Read', { file_path: '/home/dev/.config/tool/config.json' })).toEqual({
      key: 'Read(~/.config/tool/**)',
      tool: 'Read',
      danger: null,
    });
    expect(file('Grep', { pattern: 'x', path: '/opt/lib' })).toEqual({
      key: 'Read(//opt/lib/**)',
      tool: 'Read',
      danger: null,
    });
  });
});

describe('the rule of the other tools', () => {
  const key = (name: string, input: unknown = {}) => ruleKeyOf('claude-code', name, input, PLACE);

  it('fetches by domain', () => {
    expect(key('WebFetch', { url: 'https://docs.example.dev/guide?x=1' })).toEqual({
      key: 'WebFetch(domain:docs.example.dev)',
      tool: 'WebFetch',
      danger: null,
    });
    expect(key('WebFetch', { url: 'http://localhost:3000/api' })?.key).toBe(
      'WebFetch(domain:localhost)',
    );
    expect(key('WebFetch', { url: 'not a url' })?.key).toBe('WebFetch');
  });

  it('names an MCP tool, filed under its server, and the rest by their name', () => {
    expect(key('mcp__tracker__create_issue', { title: 'x' })).toEqual({
      key: 'mcp__tracker__create_issue',
      tool: 'mcp__tracker',
      danger: null,
    });
    expect(key('WebSearch', { query: 'x' })?.key).toBe('WebSearch');
    expect(key('Skill', { skill: 'pdf' })?.key).toBe('Skill');
  });

  it('has none for a tool no rule decides', () => {
    for (const name of ['Task', 'Agent', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode'])
      expect(key(name)).toBeNull();
  });

  it('keys Codex commands in its own prefix_rule syntax', () => {
    const codex = (name: string, input: unknown) => ruleKeyOf('codex', name, input, PLACE);
    expect(codex('exec_command', { cmd: ['bash', '-lc', 'npm test -- --watch=false'] })).toEqual({
      key: 'prefix_rule(pattern=["npm", "test"])',
      tool: 'prefix_rule',
      danger: null,
    });
    expect(codex('shell', { command: ['git', 'push', 'origin', 'main'] })).toEqual({
      key: 'prefix_rule(pattern=["git", "push"])',
      tool: 'prefix_rule',
      danger: 'force-push',
    });
    expect(codex('apply_patch', { input: '*** Begin Patch' })).toEqual({
      key: 'apply_patch',
      tool: 'apply_patch',
      danger: null,
    });
    expect(codex('read_file', { path: '/etc/hosts' })).toBeNull();
  });
});

const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
const REJECTED_WHY =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nuse pnpm here";

describe('how a prompt was answered', () => {
  const answer = (
    name: string,
    status: ToolCall['status'],
    resultPreview: string | null,
    agent = 'claude-code',
  ) => answerOf(agent, { name, status, resultPreview });

  it('was allowed when the call ran, even when what it ran failed', () => {
    expect(answer('Bash', 'complete', '89 passed')).toBe('allowed');
    expect(answer('Bash', 'error', 'Exit code 1\nFAIL tests/a.test.ts')).toBe('allowed');
    expect(answer('mcp__tracker__create_issue', 'error', 'rate limited')).toBe('allowed');
  });

  it('was denied when the person declined it, in the terminal or in glassbox', () => {
    expect(answer('Bash', 'error', REJECTED)).toBe('denied');
    expect(answer('Edit', 'error', REJECTED_WHY)).toBe('denied');
    expect(answer('Bash', 'error', 'The user declined this action.')).toBe('denied');
  });

  it('was never put to the person when a rule, a mode or a check stopped it first', () => {
    expect(
      answer('Bash', 'error', 'Permission to use Bash with command rm -rf / has been denied.'),
    ).toBeNull();
    expect(
      answer('Bash', 'error', 'Permission for this action has been denied. Reason: x'),
    ).toBeNull();
    expect(
      answer(
        'Bash',
        'error',
        'Permission for this action was denied by the Claude Code auto mode classifier. Reason: x',
      ),
    ).toBeNull();
    expect(answer('Edit', 'error', 'String to replace not found in file.')).toBeNull();
  });

  it('is not known for a call stopped with the rest, or without a result yet', () => {
    expect(
      answer(
        'Bash',
        'error',
        "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
      ),
    ).toBeNull();
    expect(answer('Bash', 'running', null)).toBeNull();
    expect(answer('Bash', 'unknown', null)).toBeNull();
  });

  it('reads a refusal only from an error: a file that quotes one is just a file', () => {
    expect(answer('Bash', 'complete', REJECTED)).toBe('allowed');
  });

  it('reads Codex’s own refusals', () => {
    expect(answer('exec_command', 'complete', 'exec command rejected by user', 'codex')).toBe(
      'denied',
    );
    expect(answer('apply_patch', 'complete', 'patch rejected by user', 'codex')).toBe('denied');
    expect(answer('exec_command', 'complete', 'Exit code: 0\nOutput:\nok', 'codex')).toBe(
      'allowed',
    );
  });
});

const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

function call(id: string, name: string, input: unknown, o: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    agentId: 'main',
    requestId: 'r1',
    name,
    input,
    status: 'complete',
    startedAt: iso(Number(id.replace(/\D/g, '')) || 0),
    endedAt: null,
    durationMs: null,
    resultPreview: 'ok',
    hasFullResult: false,
    spawned: null,
    ...o,
  };
}

function snapshot(agent: string, toolCalls: ToolCall[]): SessionSnapshot {
  return {
    session: {
      id: `${agent}:s1`,
      agent,
      nativeId: 's1',
      title: null,
      cwd: '/work/shop',
      project: 'shop',
      startedAt: iso(0),
      updatedAt: iso(600),
      live: 'closed',
      version: null,
      model: null,
      usage: null,
      counts: null,
    },
    agents: [],
    turns: [],
    requests: [
      {
        id: 'r1',
        agentId: 'main',
        turnId: null,
        index: 1,
        model: null,
        effort: null,
        startedAt: iso(5),
        firstBlockAt: null,
        endedAt: null,
        status: 'complete',
        stopReason: null,
        usage: null,
        blocks: [],
        toolCallIds: toolCalls.map((c) => c.id),
        hasDetail: false,
        error: null,
      },
    ],
    toolCalls,
    workflows: [],
    diagnostics: { unknownRecordTypes: {}, parseErrors: 0, unavailable: [] },
  };
}

describe('the permission events of a session', () => {
  it('lists each call a rule decides, with its rule, its answer and when it was made', () => {
    const events = permissionEvents(
      snapshot('claude-code', [
        call('t10', 'Bash', { command: 'npm test' }),
        call('t20', 'Bash', { command: 'git push' }, { status: 'error', resultPreview: REJECTED }),
        call('t30', 'Edit', { file_path: '/work/shop/src/a.ts' }),
        call('t40', 'Read', { file_path: '/work/shop/src/a.ts' }),
        call('t50', 'Task', { prompt: 'x' }),
        call('t60', 'Bash', { command: 'npm test' }, { status: 'running', resultPreview: null }),
      ]),
      PLACE,
    );
    expect(events).toEqual<PermissionEvent[]>([
      {
        key: 'Bash(npm test:*)',
        tool: 'Bash',
        agent: 'claude-code',
        answer: 'allowed',
        at: iso(10),
        toolCallId: 't10',
        danger: null,
      },
      {
        key: 'Bash(git push:*)',
        tool: 'Bash',
        agent: 'claude-code',
        answer: 'denied',
        at: iso(20),
        toolCallId: 't20',
        danger: 'force-push',
      },
      {
        key: 'Edit(src/**)',
        tool: 'Edit',
        agent: 'claude-code',
        answer: 'allowed',
        at: iso(30),
        toolCallId: 't30',
        danger: null,
      },
    ]);
  });

  it('dates a call without a start by its model call, and leaves out one with neither', () => {
    const s = snapshot('claude-code', [
      call('t1', 'Bash', { command: 'npm test' }, { startedAt: null }),
      call('t2', 'Bash', { command: 'npm test' }, { startedAt: null, requestId: 'gone' }),
    ]);
    expect(permissionEvents(s, PLACE).map((e) => [e.toolCallId, e.at])).toEqual([['t1', iso(5)]]);
  });

  it('takes a glassbox run’s answer over what the transcript can tell', () => {
    // A deny with a reason of the person's own reads in the transcript as any failed command.
    const s = snapshot('claude-code', [
      call('t1', 'Bash', { command: 'npm publish' }, { status: 'error', resultPreview: 'Not now' }),
    ]);
    expect(permissionEvents(s, PLACE)[0]?.answer).toBe('allowed');
    expect(permissionEvents(s, PLACE, new Map([['t1', 'deny']]))[0]?.answer).toBe('denied');
  });

  it('counts a Codex command only when it asked to leave the sandbox or was refused', () => {
    const s = snapshot('codex', [
      call('t1', 'exec_command', { cmd: 'npm test', sandbox_permissions: 'require_escalated' }),
      call('t2', 'exec_command', { cmd: 'npm test' }),
      call(
        't3',
        'exec_command',
        { cmd: 'git push' },
        { resultPreview: 'exec command rejected by user' },
      ),
      call('t4', 'shell', { command: ['npm', 'ci'], with_escalated_permissions: true }),
      call('t5', 'apply_patch', { input: '*** Begin Patch' }),
      call(
        't6',
        'apply_patch',
        { input: '*** Begin Patch' },
        { resultPreview: 'patch rejected by user' },
      ),
    ]);
    expect(permissionEvents(s, PLACE).map((e) => [e.toolCallId, e.key, e.answer])).toEqual([
      ['t1', 'prefix_rule(pattern=["npm", "test"])', 'allowed'],
      ['t3', 'prefix_rule(pattern=["git", "push"])', 'denied'],
      ['t4', 'prefix_rule(pattern=["npm", "ci"])', 'allowed'],
      ['t6', 'apply_patch', 'denied'],
    ]);
  });

  it('reads no agent it has no rules for', () => {
    const s = snapshot('grok', [call('t1', 'bash', { command: 'npm test' })]);
    expect(permissionEvents(s, PLACE)).toEqual([]);
  });
});

describe('the answers glassbox runs keep', () => {
  it('maps each answered prompt to allow or deny, leaving out the withdrawn and the open', () => {
    const run = (decided: RunState['decidedPermissions'], pending: string[] = []) =>
      ({
        decidedPermissions: decided,
        pendingPermissions: pending.map((id) => ({
          id,
          toolName: 'Bash',
          input: {},
          questions: null,
          requestedAt: iso(0),
        })),
      }) as RunState;
    const decided = (id: string, decision: 'allow' | 'deny' | 'cancelled') => ({
      id,
      toolName: 'Bash',
      requestedAt: iso(0),
      decidedAt: iso(1),
      decision,
    });
    expect(
      runDecisions([
        run([decided('a', 'allow'), decided('b', 'deny')]),
        run([decided('c', 'cancelled')], ['d']),
        run(undefined),
      ]),
    ).toEqual(
      new Map([
        ['a', 'allow'],
        ['b', 'deny'],
      ]),
    );
  });
});
