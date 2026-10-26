import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LiveState } from '../../core/model.js';
import type { PermissionRequest, RunState } from '../../shared/runs.js';
import { TOO_DEEP } from '../json.js';
import { memorySpawn } from './__tests__/memory-process.js';
import { spawnClaude } from './claude-process.js';
import { RunError, RunManager } from './run-manager.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassbox-runs-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
});

const SESSIONS: Record<string, { nativeId: string; cwd: string | null; live: LiveState }> = {};

function setup(
  opts: { claudeBin?: string | null; initTimeoutMs?: number; log?: (msg: string) => void } = {},
) {
  const fake = memorySpawn();
  const manager = new RunManager({
    spawn: fake.spawn,
    claudeBin: opts.claudeBin === undefined ? '/usr/local/bin/claude' : opts.claudeBin,
    resolveSession: (id) => SESSIONS[id] ?? null,
    env: { PATH: '/usr/bin', FAKE: '1' },
    initTimeoutMs: opts.initTimeoutMs,
    log: opts.log,
  });
  const events: RunState[] = [];
  manager.onRun((r) => events.push(r));
  return { manager, fake, events };
}

/** Starts a 'new' run and walks it to `running` (initialized, system/init seen). */
async function running(prompt = 'Reply with ok.') {
  const s = setup();
  const run = await s.manager.start({ mode: 'new', cwd: dir, prompt });
  const proc = s.fake.last();
  proc.initialize();
  proc.push({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5-5' });
  return {
    ...s,
    run,
    proc,
    state: () => s.manager.list().find((r) => r.id === run.id) as RunState,
  };
}

const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  session_id: 'sess-1',
  total_cost_usd: 0.12,
  duration_ms: 1300,
  num_turns: 1,
  ...extra,
});

const canUseTool = (
  toolUseId: string,
  requestId: string,
  tool = 'Bash',
  input: object = { command: 'touch x' },
) => ({
  type: 'control_request',
  request_id: requestId,
  request: {
    subtype: 'can_use_tool',
    tool_name: tool,
    display_name: tool,
    input,
    tool_use_id: toolUseId,
  },
});

describe('starting a run', () => {
  it('spawns claude with the stream-json flags, initializes, then sends the prompt', async () => {
    const { manager, fake } = setup();
    const run = await manager.start({ mode: 'new', cwd: dir, prompt: 'Reply with ok.' });
    const proc = fake.last();
    expect(proc.opts).toMatchObject({
      bin: '/usr/local/bin/claude',
      cwd: dir,
      env: { PATH: '/usr/bin', FAKE: '1' },
    });
    expect(proc.opts.args).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool=stdio',
      '--permission-mode',
      'default',
      '--setting-sources',
      'user,project,local',
    ]);
    expect(run).toMatchObject({
      status: 'starting',
      mode: 'new',
      cwd: dir,
      sessionId: null,
      permissionMode: 'default',
    });
    expect(proc.sent.map((m) => m.type)).toEqual(['control_request']);

    proc.initialize();
    expect(proc.sentOf('user')).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'Reply with ok.' },
        parent_tool_use_id: null,
      },
    ]);
    proc.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    expect(manager.list()[0]).toMatchObject({ status: 'running', sessionId: 'claude-code:sess-1' });
    expect(JSON.stringify(manager.list())).not.toContain('example.invalid');
  });

  it('passes model, effort and permission mode only when set', async () => {
    const { manager, fake } = setup();
    await manager.start({
      mode: 'new',
      cwd: dir,
      prompt: 'x',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      permissionMode: 'plan',
    });
    const args = fake.last().opts.args;
    expect(
      args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2),
    ).toEqual(['--permission-mode', 'plan']);
    expect(args).toEqual(
      expect.arrayContaining(['--model', 'claude-sonnet-5-5', '--effort', 'high']),
    );
    expect(manager.list()[0]?.permissionMode).toBe('plan');
  });

  it('resume continues a closed session in place; fork copies a live one', async () => {
    SESSIONS['claude-code:aaa'] = { nativeId: 'aaa', cwd: dir, live: 'closed' };
    SESSIONS['claude-code:bbb'] = { nativeId: 'bbb', cwd: dir, live: 'busy' };
    const { manager, fake } = setup();
    const resumed = await manager.start({
      mode: 'resume',
      sessionId: 'claude-code:aaa',
      prompt: 'go on',
    });
    expect(fake.last().opts.args.slice(-2)).toEqual(['--resume', 'aaa']);
    expect(resumed.sessionId).toBe('claude-code:aaa');
    const forked = await manager.start({
      mode: 'fork',
      sessionId: 'claude-code:bbb',
      prompt: 'go on',
    });
    expect(fake.last().opts.args.slice(-3)).toEqual(['--resume', 'bbb', '--fork-session']);
    expect(forked.sessionId).toBeNull();
  });

  it.each([
    [
      'no claude binary',
      { claudeBin: null },
      { mode: 'new', cwd: '', prompt: 'x' },
      503,
      'The claude command was not found',
    ],
    [
      'a relative directory',
      {},
      { mode: 'new', cwd: 'relative/dir', prompt: 'x' },
      400,
      'The working directory does not exist or is not an absolute path',
    ],
    [
      'a missing directory',
      {},
      { mode: 'new', cwd: '/definitely/not/here', prompt: 'x' },
      400,
      'The working directory does not exist or is not an absolute path',
    ],
    [
      'an empty prompt',
      {},
      { mode: 'new', cwd: '/tmp', prompt: '  ' },
      400,
      'The message cannot be empty',
    ],
    [
      'an unknown session',
      {},
      { mode: 'resume', sessionId: 'claude-code:nope', prompt: 'x' },
      404,
      'Session not found',
    ],
  ] as const)('rejects %s', async (_name, opts, req, status, message) => {
    const { manager, fake } = setup(opts);
    const err = await manager.start(req as never).catch((e) => e);
    expect(err).toBeInstanceOf(RunError);
    expect(err.status).toBe(status);
    expect(err.message).toBe(message);
    expect(fake.procs).toHaveLength(0);
  });

  it('refuses to resume a session that a terminal has open (409, suggests fork)', async () => {
    SESSIONS['claude-code:ccc'] = { nativeId: 'ccc', cwd: dir, live: 'idle' };
    const { manager } = setup();
    const err = await manager
      .start({ mode: 'resume', sessionId: 'claude-code:ccc', prompt: 'x' })
      .catch((e) => e);
    expect(err).toMatchObject({ status: 409 });
    expect(err.message).toBe(
      'This session is running in a terminal and cannot be continued directly; use “Continue in a copy” instead',
    );
  });
});

describe('a turn', () => {
  it('streams the partial, then goes idle with the result summary', async () => {
    const { proc, state } = await running();
    proc.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } });
    proc.push({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    proc.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    });
    expect(state().partial).toMatchObject({ messageId: 'msg_1', text: 'ok' });
    proc.push({ type: 'stream_event', event: { type: 'message_stop' } });
    proc.push(result());
    expect(state()).toMatchObject({
      status: 'idle',
      partial: null,
      error: null,
      last: { costUsd: 0.12, durationMs: 1300, numTurns: 1 },
    });
  });

  it('coalesces partial updates to at most 20 events per second', async () => {
    vi.useFakeTimers();
    const { proc, events, state } = await running();
    const before = events.length;
    proc.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } });
    proc.push({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    for (let i = 0; i < 100; i++)
      proc.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } },
      });
    vi.advanceTimersByTime(60);
    const emitted = events.slice(before);
    expect(emitted.length).toBeLessThanOrEqual(2);
    expect(emitted.at(-1)?.partial?.text).toHaveLength(100);
    expect(state().partial?.text).toHaveLength(100);
  });

  it('a follow-up while the reply is still running is refused (409); once idle it is sent', async () => {
    const { manager, run, proc } = await running();
    expect(() => manager.send(run.id, 'more')).toThrow(RunError);
    try {
      manager.send(run.id, 'more');
    } catch (e) {
      expect((e as RunError).status).toBe(409);
    }
    proc.push(result());
    manager.send(run.id, 'more');
    expect(proc.sentOf('user').at(-1)).toMatchObject({ message: { content: 'more' } });
    expect(manager.list()[0]?.status).toBe('running');
  });

  it('an errored turn shows a readable reason; not being logged in is spelled out', async () => {
    const { proc, state, manager, run } = await running();
    proc.push(result({ is_error: true, result: 'Not logged in · Please run /login' }));
    expect(state()).toMatchObject({
      status: 'idle',
      error: 'Claude Code is not logged in; run claude in a terminal to log in first',
    });
    manager.send(run.id, 'again');
    expect(state().error).toBeNull();
    proc.push(
      result({
        subtype: 'error_max_turns',
        is_error: true,
        result: '',
        errors: ['too many turns', 'stopped'],
      }),
    );
    expect(state().error).toBe('This turn failed: too many turns; stopped');
  });

  // F S2: the error is masked where it is made, so no view shows a home path or a credential.
  it('masks a run’s error: the home directory as ~, credentials hidden', async () => {
    const home = process.env.HOME ?? '/home/someone';
    const { proc, state, manager, run } = await running();
    proc.push(
      result({
        is_error: true,
        result: `cannot read ${home}/dev/app/.env: API_KEY="Kx9mQ2pLvR7tW3nZ" is invalid`,
      }),
    );
    expect(state().error).toBe(
      'This turn failed: cannot read ~/dev/app/.env: API_KEY=••• is invalid',
    );
    manager.send(run.id, 'again');
    proc.exit(1, [`fatal: ${home}/dev/app: password is "hunter2hunter2"`]);
    expect(state().error).toBe('fatal: ~/dev/app: password is •••');
    expect(JSON.stringify(manager.list())).not.toContain(home);
  });

  it('ignores unknown and malformed messages', async () => {
    const { proc, state } = await running();
    proc.push({ type: 'brand_new_message' });
    proc.push({ type: 'stream_event', event: null });
    proc.push({ type: 'system', subtype: 'hook_started' });
    proc.push({ type: 'rate_limit_event', rate_limit_info: {} });
    expect(state().status).toBe('running');
  });
});

describe('permissions', () => {
  it('a prompt with nobody watching stays pending with no timeout', async () => {
    vi.useFakeTimers();
    const { proc, state, manager, run } = await running();
    proc.push(canUseTool('toolu_1', 'req-1'));
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(state()).toMatchObject({
      status: 'waiting-permission',
      pendingPermissions: [
        { id: 'toolu_1', toolName: 'Bash', input: { command: 'touch x' }, questions: null },
      ],
    });
    manager.decide(run.id, 'toolu_1', { decision: 'allow' });
    expect(proc.sentOf('control_response').at(-1)).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: { behavior: 'allow', updatedInput: { command: 'touch x' } },
      },
    });
    expect(state()).toMatchObject({ status: 'running', pendingPermissions: [] });
  });

  it('deny says the user declined, then their reason, so the transcript says it too', async () => {
    const { proc, manager, run } = await running();
    proc.push(canUseTool('toolu_1', 'req-1'));
    proc.push(canUseTool('toolu_2', 'req-2'));
    manager.decide(run.id, 'toolu_1', { decision: 'deny', message: 'Not in this repo' });
    expect(manager.list()[0]?.status).toBe('waiting-permission');
    manager.decide(run.id, 'toolu_2', { decision: 'deny' });
    const [a, b] = proc
      .sentOf('control_response')
      .map((m) => (m.response as { response: unknown }).response);
    expect(a).toEqual({
      behavior: 'deny',
      message: 'The user declined this action. The user said: Not in this repo',
    });
    expect(b).toEqual({ behavior: 'deny', message: 'The user declined this action.' });
  });

  it('AskUserQuestion carries its questions and is answered with answers by question text', async () => {
    const { proc, state, manager, run } = await running();
    const questions = [
      {
        question: 'Pick a colour',
        header: 'Colour',
        multiSelect: false,
        options: [
          { label: 'red', description: 'Red' },
          { label: 'blue', description: 'Blue' },
        ],
      },
      {
        question: 'Which sizes?',
        header: 'Sizes',
        multiSelect: true,
        options: [
          { label: 'S', description: '' },
          { label: 'M', description: '' },
        ],
      },
    ];
    proc.push(canUseTool('toolu_q', 'req-q', 'AskUserQuestion', { questions }));
    expect(state().pendingPermissions[0]?.questions).toEqual(questions);
    manager.decide(run.id, 'toolu_q', {
      decision: 'allow',
      answers: { 'Pick a colour': 'blue', 'Which sizes?': ['S', 'M'] },
    });
    expect(
      (proc.sentOf('control_response').at(-1)?.response as { response: unknown } | undefined)
        ?.response,
    ).toEqual({
      behavior: 'allow',
      updatedInput: { questions, answers: { 'Pick a colour': 'blue', 'Which sizes?': 'S, M' } },
    });
  });

  it('two watchers see the same pending prompt, and both see it answered', async () => {
    const { proc, manager, run } = await running();
    const a: RunState[] = [];
    const b: RunState[] = [];
    manager.onRun((r) => a.push(r));
    const offB = manager.onRun((r) => b.push(r));
    proc.push(canUseTool('toolu_1', 'req-1'));
    expect(a.at(-1)?.pendingPermissions).toEqual(b.at(-1)?.pendingPermissions);
    manager.decide(run.id, 'toolu_1', { decision: 'allow' });
    expect(a.at(-1)?.pendingPermissions).toEqual([]);
    expect(b.at(-1)?.pendingPermissions).toEqual([]);
    offB();
    proc.push(result());
    expect(b.at(-1)?.status).not.toBe('idle');
  });

  it('a prompt Claude Code withdraws disappears; prompts pending at initialize are restored', async () => {
    const { proc, state } = await running();
    proc.push(canUseTool('toolu_1', 'req-1'));
    proc.push({ type: 'control_cancel_request', request_id: 'req-1' });
    expect(state()).toMatchObject({ status: 'running', pendingPermissions: [] });

    const s = setup();
    await s.manager.start({ mode: 'new', cwd: dir, prompt: 'x' });
    const p = s.fake.last();
    const req = p.sentOf('control_request', 'initialize')[0] as { request_id: string };
    p.push({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: req.request_id,
        response: { claude_code_version: '2.1.308' },
        pending_permission_requests: [canUseTool('toolu_9', 'req-9')],
      },
    });
    expect(s.manager.list()[0]?.pendingPermissions.map((x) => x.id)).toEqual(['toolu_9']);
  });

  it('unknown runs and permissions are 404', async () => {
    const { manager, run } = await running();
    const status = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        return (e as RunError).status;
      }
      return null;
    };
    expect(status(() => manager.decide(run.id, 'nope', { decision: 'allow' }))).toBe(404);
    expect(status(() => manager.decide('run-nope', 'x', { decision: 'allow' }))).toBe(404);
    expect(status(() => manager.send('run-nope', 'x'))).toBe(404);
    expect(status(() => manager.close('run-nope'))).toBe(404);
    expect(await manager.interrupt('run-nope').catch((e) => e.status)).toBe(404);
  });
});

describe('interrupt and the end of a run', () => {
  it('interrupt asks Claude Code to stop; the aborted turn is not an error', async () => {
    const { proc, manager, run, state } = await running();
    const done = manager.interrupt(run.id);
    const req = proc.sentOf('control_request', 'interrupt')[0] as { request_id: string };
    proc.push({
      type: 'control_response',
      response: { subtype: 'success', request_id: req.request_id, response: { still_queued: [] } },
    });
    await done;
    proc.push(
      result({
        subtype: 'error_during_execution',
        is_error: true,
        result: '',
        terminal_reason: 'aborted_streaming',
      }),
    );
    expect(state()).toMatchObject({ status: 'idle', error: null });
  });

  it('close ends stdin; the exit that follows is a clean close', async () => {
    const { proc, manager, run, state } = await running();
    proc.push(result());
    manager.close(run.id);
    expect(proc.ended).toBe(true);
    proc.exit(0);
    expect(state()).toMatchObject({ status: 'closed', error: null });
  });

  it('an unexpected exit mid-turn is an error with the last stderr line', async () => {
    const { proc, state } = await running();
    proc.push(canUseTool('toolu_1', 'req-1'));
    proc.exit(1, ['warming up', 'Error: connection reset']);
    expect(state()).toMatchObject({
      status: 'error',
      error: 'Error: connection reset',
      partial: null,
      pendingPermissions: [],
    });
  });

  it('an exit with nothing on stderr still says what happened', async () => {
    const { proc, state } = await running();
    proc.exit(null, [], 'SIGKILL');
    expect(state().status).toBe('error');
    expect(state().error).toBe('The claude process exited unexpectedly (signal SIGKILL)');
  });
});

describe('protocol compatibility', () => {
  it('no initialize response in time → error naming the version, process killed', async () => {
    vi.useFakeTimers();
    const { manager, fake } = setup({ initTimeoutMs: 10_000 });
    await manager.start({ mode: 'new', cwd: dir, prompt: 'x' });
    vi.advanceTimersByTime(10_001);
    expect(manager.list()[0]).toMatchObject({ status: 'error' });
    expect(manager.list()[0]?.error).toBe(
      "This Claude Code version's streaming protocol is incompatible (version unknown)",
    );
    expect(fake.last().killed).toBe(true);
    expect(fake.last().sentOf('user')).toEqual([]);
  });

  it('an unknown control request → refused, run error naming the version', async () => {
    const { proc, state } = await running();
    proc.push({
      type: 'control_request',
      request_id: 'req-x',
      request: { subtype: 'brand_new_thing' },
    });
    expect(proc.sentOf('control_response').at(-1)).toMatchObject({
      response: { subtype: 'error', request_id: 'req-x' },
    });
    expect(state().status).toBe('error');
    expect(state().error).toBe(
      "This Claude Code version's streaming protocol is incompatible (version 2.1.308)",
    );
    expect(proc.killed).toBe(true);
  });
});

describe('with a real child process (fake claude binary)', () => {
  const FAKE = join(import.meta.dirname, '__tests__', 'fake-claude.mjs');
  const e2e = (scenario: object[]) => {
    const manager = new RunManager({
      spawn: spawnClaude,
      claudeBin: FAKE,
      resolveSession: () => null,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario) },
    });
    const states: RunState[] = [];
    manager.onRun((r) => states.push(r));
    const until = async (cond: (r: RunState) => boolean) => {
      const t0 = Date.now();
      while (!states.some(cond)) {
        if (Date.now() - t0 > 5000)
          throw new Error(`timed out; last: ${JSON.stringify(states.at(-1))}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      return states.find(cond) as RunState;
    };
    return { manager, states, until };
  };

  it('a full turn with a permission prompt', async () => {
    const { manager, until } = e2e([
      { wait: { type: 'control_request', request: { subtype: 'initialize' } } },
      {
        emit: {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: '$id',
            response: { claude_code_version: '2.1.308' },
          },
        },
      },
      { wait: { type: 'user' } },
      { emit: { type: 'system', subtype: 'init', session_id: 'sess-e2e' } },
      {
        emit: { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } },
      },
      { emit: { type: 'stream_event', event: { type: 'message_stop' } } },
      {
        emit: {
          type: 'control_request',
          request_id: 'perm-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'touch a' },
            tool_use_id: 'toolu_1',
          },
        },
      },
      {
        wait: {
          type: 'control_response',
          response: { request_id: 'perm-1', response: { behavior: 'allow' } },
        },
      },
      {
        emit: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'done',
          total_cost_usd: 0.01,
          duration_ms: 50,
          num_turns: 1,
        },
      },
    ]);
    const run = await manager.start({ mode: 'new', cwd: dir, prompt: 'touch a' });
    await until((r) => r.status === 'waiting-permission');
    manager.decide(run.id, 'toolu_1', { decision: 'allow' });
    const idle = await until((r) => r.status === 'idle');
    expect(idle).toMatchObject({
      sessionId: 'claude-code:sess-e2e',
      error: null,
      last: { numTurns: 1 },
    });
    manager.close(run.id);
    await until((r) => r.status === 'closed');
  });

  it('a process that dies mid-turn leaves the run in error with its last stderr line', async () => {
    const { manager, until } = e2e([
      { wait: { type: 'control_request', request: { subtype: 'initialize' } } },
      {
        emit: {
          type: 'control_response',
          response: { subtype: 'success', request_id: '$id', response: {} },
        },
      },
      { wait: { type: 'user' } },
      { emit: { type: 'system', subtype: 'init', session_id: 'sess-e2e' } },
      {
        emit: { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } },
      },
      { stderr: 'Error: socket hang up' },
      { exit: 1 },
    ]);
    await manager.start({ mode: 'new', cwd: dir, prompt: 'hi' });
    const failed = await until((r) => r.status === 'error');
    expect(failed).toMatchObject({ error: 'Error: socket hang up', partial: null });
  });
});

describe('review fixes', () => {
  it('a failed run stays failed: later messages and the exit keep the incompatibility message', async () => {
    const { proc, state, manager, run } = await running();
    proc.push({
      type: 'control_request',
      request_id: 'req-x',
      request: { subtype: 'brand_new_thing' },
    });
    const message = state().error;
    proc.push(result());
    proc.push(canUseTool('toolu_1', 'req-1'));
    expect(state()).toMatchObject({ status: 'error', error: message, pendingPermissions: [] });
    expect(() => manager.send(run.id, 'more')).toThrow(RunError);
    proc.exit(null, [], 'SIGTERM');
    expect(state()).toMatchObject({ status: 'error', error: message });
  });

  it('a late initialize response after the timeout does not revive the run', async () => {
    vi.useFakeTimers();
    const { manager, fake } = setup({ initTimeoutMs: 10_000 });
    await manager.start({ mode: 'new', cwd: dir, prompt: 'x' });
    vi.advanceTimersByTime(10_001);
    fake.last().initialize();
    expect(manager.list()[0]?.status).toBe('error');
    expect(fake.last().sentOf('user')).toEqual([]);
  });

  it('interrupt while starting cancels the first prompt; the next turn reports its own errors', async () => {
    const { manager, fake } = setup();
    const run = await manager.start({ mode: 'new', cwd: dir, prompt: 'never mind' });
    await manager.interrupt(run.id);
    const proc = fake.last();
    proc.initialize();
    expect(proc.sentOf('user')).toEqual([]);
    expect(proc.sentOf('control_request', 'interrupt')).toEqual([]);
    expect(manager.list()[0]?.status).toBe('idle');
    manager.send(run.id, 'now go');
    proc.push(result({ is_error: true, result: 'Not logged in · Please run /login' }));
    expect(manager.list()[0]?.error).toContain('not logged in');
  });

  it('a session can only be resumed by one run at a time', async () => {
    SESSIONS['claude-code:ddd'] = { nativeId: 'ddd', cwd: dir, live: 'closed' };
    const { manager, fake } = setup();
    const [a, b] = await Promise.allSettled([
      manager.start({ mode: 'resume', sessionId: 'claude-code:ddd', prompt: 'one' }),
      manager.start({ mode: 'resume', sessionId: 'claude-code:ddd', prompt: 'two' }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    const err = (
      a.status === 'rejected' ? a.reason : (b as PromiseRejectedResult).reason
    ) as RunError;
    expect(err.status).toBe(409);
    expect(fake.procs).toHaveLength(1);
    // Once that run has ended the session can be resumed again.
    fake.last().exit(1, ['gone']);
    await manager.start({ mode: 'resume', sessionId: 'claude-code:ddd', prompt: 'three' });
    expect(fake.procs).toHaveLength(2);
  });

  it('slow SessionStart hooks are not mistaken for an incompatible CLI', async () => {
    vi.useFakeTimers();
    const { manager, fake } = setup({ initTimeoutMs: 10_000 });
    await manager.start({ mode: 'new', cwd: dir, prompt: 'x' });
    const proc = fake.last();
    vi.advanceTimersByTime(9_000);
    proc.push({ type: 'system', subtype: 'hook_started', hook_event: 'SessionStart' });
    vi.advanceTimersByTime(9_000);
    proc.push({ type: 'system', subtype: 'hook_response', hook_event: 'SessionStart' });
    vi.advanceTimersByTime(9_000);
    proc.initialize();
    expect(manager.list()[0]?.status).not.toBe('error');
    expect(proc.sentOf('user')).toHaveLength(1);
  });

  it('a listener that throws neither crashes the stream nor starves other listeners', async () => {
    const { proc, manager, state } = await running();
    const seen: RunState[] = [];
    manager.onRun(() => {
      throw new Error('listener bug');
    });
    manager.onRun((r) => seen.push(r));
    expect(() => proc.push(result())).not.toThrow();
    expect(seen.at(-1)?.status).toBe('idle');
    expect(() =>
      proc.push({
        type: 'control_request',
        request_id: 'r',
        request: { subtype: 'brand_new_thing' },
      }),
    ).not.toThrow();
    // The unknown request fails the run (by design); every listener still hears about it.
    expect(state().status).toBe('error');
    expect(seen.at(-1)?.status).toBe('error');
  });

  it('a listener that throws during the incompatibility path still lets the process be killed', async () => {
    const { proc, manager } = await running();
    manager.onRun(() => {
      throw new Error('listener bug');
    });
    proc.push({
      type: 'control_request',
      request_id: 'r',
      request: { subtype: 'brand_new_thing' },
    });
    expect(proc.killed).toBe(true);
  });

  it('sub-agent stream events do not leak into the main partial', async () => {
    const { proc, state } = await running();
    proc.push({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg_main' } },
    });
    proc.push({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    proc.push({
      type: 'stream_event',
      parent_tool_use_id: 'toolu_agent',
      event: { type: 'message_start', message: { id: 'msg_sub' } },
    });
    proc.push({
      type: 'stream_event',
      parent_tool_use_id: 'toolu_agent',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub' } },
    });
    proc.push({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'main' } },
    });
    expect(state().partial).toMatchObject({ messageId: 'msg_main', text: 'main' });
  });

  it('a prompt that arrives while idle returns the run to idle once answered', async () => {
    const { proc, manager, run, state } = await running();
    proc.push(result());
    proc.push(canUseTool('toolu_bg', 'req-bg'));
    expect(state().status).toBe('waiting-permission');
    manager.decide(run.id, 'toolu_bg', { decision: 'allow' });
    expect(state().status).toBe('idle');
    manager.send(run.id, 'next');
  });

  it.each([
    ['an unknown permission mode', { permissionMode: 'bypassPermissions' }],
    ['an unknown effort', { effort: 'ultra' }],
    ['a model that looks like a flag', { model: '--dangerously-skip-permissions' }],
  ])('rejects %s before spawning', async (_name, extra) => {
    const { manager, fake } = setup();
    const err = await manager
      .start({ mode: 'new', cwd: dir, prompt: 'x', ...extra } as never)
      .catch((e) => e);
    expect(err).toMatchObject({ status: 400 });
    expect(fake.procs).toHaveLength(0);
  });

  it('a malformed decision is a 400 and the prompt stays pending', async () => {
    const { proc, manager, run, state } = await running();
    proc.push(canUseTool('toolu_1', 'req-1'));
    const status = (d: unknown) => {
      try {
        manager.decide(run.id, 'toolu_1', d as never);
      } catch (e) {
        return (e as RunError).status;
      }
      return null;
    };
    expect(status({ decision: 'maybe' })).toBe(400);
    expect(status({ decision: 'deny', message: 42 })).toBe(400);
    expect(status({ decision: 'allow', answers: 'blue' })).toBe(400);
    expect(state().pendingPermissions).toHaveLength(1);
    expect(proc.sentOf('control_response')).toEqual([]);
  });
});

describe('decided permissions', () => {
  const decided = (state: () => RunState) =>
    (state().decidedPermissions ?? []).map((d) => [d.id, d.toolName, d.decision]);

  it('records each answer with when it was asked and when it was answered', async () => {
    const { proc, manager, run, state } = await running();
    expect(state().decidedPermissions).toEqual([]);
    proc.push(canUseTool('toolu_1', 'req-1'));
    proc.push(canUseTool('toolu_2', 'req-2', 'Write'));
    manager.decide(run.id, 'toolu_1', { decision: 'allow' });
    manager.decide(run.id, 'toolu_2', { decision: 'deny', message: 'no' });
    expect(decided(state)).toEqual([
      ['toolu_1', 'Bash', 'allow'],
      ['toolu_2', 'Write', 'deny'],
    ]);
    const first = state().decidedPermissions?.[0];
    expect(first && Date.parse(first.decidedAt) >= Date.parse(first.requestedAt)).toBe(true);
  });

  it('a prompt Claude Code withdraws is recorded as cancelled', async () => {
    const { proc, state } = await running();
    proc.push(canUseTool('toolu_1', 'req-1'));
    proc.push({ type: 'control_cancel_request', request_id: 'req-1' });
    expect(decided(state)).toEqual([['toolu_1', 'Bash', 'cancelled']]);
  });

  it('a prompt restored at initialize is recorded the same way', async () => {
    const s = setup();
    await s.manager.start({ mode: 'new', cwd: dir, prompt: 'x' });
    const p = s.fake.last();
    const req = p.sentOf('control_request', 'initialize')[0] as { request_id: string };
    p.push({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: req.request_id,
        response: { claude_code_version: '2.1.308' },
        pending_permission_requests: [canUseTool('toolu_9', 'req-9')],
      },
    });
    const run = s.manager.list()[0] as RunState;
    s.manager.decide(run.id, 'toolu_9', { decision: 'allow' });
    expect((s.manager.list()[0]?.decidedPermissions ?? []).map((d) => d.id)).toEqual(['toolu_9']);
  });

  it('keeps the latest 200', async () => {
    const { proc, manager, run, state } = await running();
    for (let i = 0; i < 205; i++) {
      proc.push(canUseTool(`toolu_${i}`, `req-${i}`));
      manager.decide(run.id, `toolu_${i}`, { decision: 'allow' });
    }
    const ids = (state().decidedPermissions ?? []).map((d) => d.id);
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe('toolu_5');
    expect(ids.at(-1)).toBe('toolu_204');
  });
});

describe('limits', () => {
  it('refuses a ninth live run with 429, and accepts one again after a run ends', async () => {
    const s = setup();
    for (let i = 0; i < 8; i++)
      await s.manager.start({ mode: 'new', cwd: dir, prompt: `run ${i}` });
    await expect(
      s.manager.start({ mode: 'new', cwd: dir, prompt: 'one more' }),
    ).rejects.toMatchObject({
      status: 429,
      message: 'Too many sessions running at once',
    });
    expect(s.fake.procs).toHaveLength(8);
    s.fake.last().exit(0);
    await expect(
      s.manager.start({ mode: 'new', cwd: dir, prompt: 'now fine' }),
    ).resolves.toMatchObject({
      status: 'starting',
    });
  });

  it('refuses a prompt over 200 KB (UTF-8) when starting and when sending', async () => {
    const limit = 200 * 1024;
    const s = setup();
    await expect(
      s.manager.start({ mode: 'new', cwd: dir, prompt: 'x'.repeat(limit + 1) }),
    ).rejects.toMatchObject({
      status: 400,
    });
    // Counted in bytes: 3-byte characters reach the limit sooner.
    await expect(
      s.manager.start({ mode: 'new', cwd: dir, prompt: '字'.repeat(limit / 3 + 1) }),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(s.fake.procs).toHaveLength(0);
    await expect(
      s.manager.start({ mode: 'new', cwd: dir, prompt: 'x'.repeat(limit) }),
    ).resolves.toBeTruthy();

    const { proc, manager, run } = await running();
    proc.push(result());
    expect(() => manager.send(run.id, 'y'.repeat(limit + 1))).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => manager.send(run.id, 'y'.repeat(limit))).not.toThrow();
  });
});

describe('a permission prompt nested too deep to copy or stringify', () => {
  const DEPTH = 20_000;
  const DEEP = `${'{"a":'.repeat(DEPTH)}1${'}'.repeat(DEPTH)}`;
  /** Levels of `{"a": …}` above the leaf, and the leaf. */
  const walk = (input: unknown) => {
    let v = input;
    let levels = 0;
    while (typeof v === 'object' && v !== null) {
      v = (v as { a: unknown }).a;
      levels++;
    }
    return { levels, leaf: v };
  };
  const shownInput = (s: RunState) => (s.pendingPermissions[0] as PermissionRequest).input;

  it('is shown cut at 256 levels, and answered with the original input', async () => {
    const r = await running();
    const input = JSON.parse(DEEP);
    r.proc.push(canUseTool('toolu_deep', 'perm-deep', 'Bash', input));

    const shown = r.state();
    expect(shown.status).toBe('waiting-permission');
    expect(walk(shownInput(shown))).toEqual({ levels: 256, leaf: TOO_DEEP });
    const event = r.events.at(-1) as RunState;
    expect(event.status).toBe('waiting-permission');
    expect(walk(shownInput(event))).toEqual({ levels: 256, leaf: TOO_DEEP });

    r.manager.decide(r.run.id, 'toolu_deep', { decision: 'allow' });
    const reply = r.proc.sentOf('control_response').at(-1) as {
      response: { request_id: string; response: { behavior: string; updatedInput: unknown } };
    };
    expect(reply.response.request_id).toBe('perm-deep');
    expect(reply.response.response.behavior).toBe('allow');
    expect(reply.response.response.updatedInput).toBe(input);
  });

  it('a message that cannot be handled fails its own run only', async () => {
    const logs: string[] = [];
    const s = setup({ log: (m) => logs.push(m) });
    const a = await s.manager.start({ mode: 'new', cwd: dir, prompt: 'a' });
    const procA = s.fake.last();
    procA.initialize();
    const b = await s.manager.start({ mode: 'new', cwd: dir, prompt: 'b' });
    const procB = s.fake.last();
    procB.initialize();

    const broken = {
      get type(): string {
        throw new Error('boom');
      },
    };
    expect(() => procA.push(broken)).not.toThrow();
    const stateOf = (id: string) => s.manager.list().find((x) => x.id === id) as RunState;
    expect(stateOf(a.id)).toMatchObject({
      status: 'error',
      error: expect.stringContaining('boom'),
    });
    expect(procA.killed).toBe(true);
    expect(logs.some((l) => l.includes(a.id) && l.includes('boom'))).toBe(true);

    procB.push(result());
    expect(stateOf(b.id).status).toBe('idle');
    expect(procB.killed).toBe(false);
  });
});
