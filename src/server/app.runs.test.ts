import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoSessions } from '../core/fixtures/demo.js';
import type { SessionSummary } from '../core/model.js';
import { TOKEN_HEADER } from '../shared/protocol.js';
import type { RunState, StartRunRequest } from '../shared/runs.js';
import { runsApi } from '../shared/runs.js';
import { sseReader } from './__tests__/sse-reader.js';
import { blankRun, StubRuns, statusError } from './__tests__/stub-runs.js';
import { type AppStore, createApp } from './app.js';
import { TOO_DEEP } from './json.js';
import { ClientCounter } from './run-reaper.js';
import { spawnClaude } from './runners/claude-process.js';
import { RunManager } from './runners/run-manager.js';
import { createSecurity } from './security.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'glassbox-runs-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(tmp, { recursive: true, force: true });
});

/** A store with a fixed session list and nothing else going on. */
function storeWith(sessions: SessionSummary[] = []): AppStore {
  return {
    listSessions: () => sessions,
    getSnapshot: async () => null,
    getRequestDetail: async () => null,
    getToolResult: async () => ({ found: false, result: undefined }),
    onSessions: () => () => {},
    onPatch: () => () => {},
    listQuotas: () => [],
    expectSession: async () => false,
    onQuota: () => () => {},
  };
}

function setup(opts: { runs?: StubRuns | null; sessions?: SessionSummary[] } = {}) {
  const runs = opts.runs === undefined ? new StubRuns() : opts.runs;
  const security = createSecurity();
  const clients = new ClientCounter();
  const app = createApp({
    store: storeWith(opts.sessions),
    security,
    runs,
    clients,
    log: () => {},
  });
  const call = (method: string, path: string, body?: unknown, raw?: string) =>
    app.request(path, {
      method,
      headers: { [TOKEN_HEADER]: security.token, 'content-type': 'application/json' },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  return { app, runs: runs as StubRuns, call, clients, token: security.token };
}

describe('POST /api/runs', () => {
  it('starts a new run in an existing absolute directory', async () => {
    const t = setup();
    const req: StartRunRequest = { mode: 'new', cwd: tmp, prompt: 'reply with the word ok' };
    const res = await t.call('POST', runsApi.runs(), req);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { run: RunState }).run.id).toBe('run-1');
    expect(t.runs.calls).toEqual([{ method: 'start', args: [req] }]);
  });

  it('passes resume and fork requests with their session id', async () => {
    const t = setup();
    for (const mode of ['resume', 'fork'] as const) {
      const req: StartRunRequest = {
        mode,
        sessionId: 'claude-code:abc',
        prompt: 'continue',
        permissionMode: 'acceptEdits',
        model: 'claude-opus-5-5',
        effort: 'high',
      };
      expect((await t.call('POST', runsApi.runs(), req)).status).toBe(201);
    }
    expect(t.runs.calls.map((c) => (c.args[0] as StartRunRequest).mode)).toEqual([
      'resume',
      'fork',
    ]);
  });

  it.each([
    ['not json', undefined, '{"mode":'],
    ['not an object', [], undefined],
    ['unknown mode', { mode: 'replay', cwd: '/', prompt: 'x' }, undefined],
    ['empty prompt', { mode: 'new', cwd: '/', prompt: '  ' }, undefined],
    ['prompt not a string', { mode: 'new', cwd: '/', prompt: 42 }, undefined],
    ['resume without session', { mode: 'resume', prompt: 'x' }, undefined],
    ['fork without session', { mode: 'fork', sessionId: '', prompt: 'x' }, undefined],
    ['new without cwd', { mode: 'new', prompt: 'x' }, undefined],
    ['new with a relative cwd', { mode: 'new', cwd: 'repo', prompt: 'x' }, undefined],
    [
      'bad permission mode',
      { mode: 'fork', sessionId: 's', prompt: 'x', permissionMode: 'yolo' },
      undefined,
    ],
    ['bad effort', { mode: 'fork', sessionId: 's', prompt: 'x', effort: 'extreme' }, undefined],
    ['model not a string', { mode: 'fork', sessionId: 's', prompt: 'x', model: 5 }, undefined],
  ])('rejects %s with 400', async (_name, body, raw) => {
    const t = setup();
    const res = await t.call('POST', runsApi.runs(), body, raw);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
    expect(t.runs.calls).toEqual([]);
  });

  it.each(['resume', 'fork'])('refuses to %s a session of another agent', async (mode) => {
    const t = setup();
    const res = await t.call('POST', runsApi.runs(), {
      mode,
      sessionId: 'grok:01a1649b-ee34-7651-88cc-729c8f77c4da',
      prompt: 'x',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Only Claude Code sessions can be continued; other agents' sessions are view-only",
    );
    expect(t.runs.calls).toEqual([]);
  });

  it('rejects a new run in a directory that does not exist, or is a file', async () => {
    const t = setup();
    await writeFile(join(tmp, 'file'), '');
    for (const cwd of [join(tmp, 'missing'), join(tmp, 'file')]) {
      const res = await t.call('POST', runsApi.runs(), { mode: 'new', cwd, prompt: 'x' });
      expect(res.status).toBe(400);
    }
    expect(t.runs.calls).toEqual([]);
  });

  it('maps run-manager errors by their status, others to 500', async () => {
    const t = setup();
    const req = { mode: 'resume', sessionId: 'claude-code:busy', prompt: 'x' };
    t.runs.failNext.set(
      'start',
      statusError(409, 'This session is running in a terminal; use “Continue in a copy” instead'),
    );
    const conflict = await t.call('POST', runsApi.runs(), req);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: 'This session is running in a terminal; use “Continue in a copy” instead',
    });

    t.runs.failNext.set('start', new Error('spawn EACCES'));
    const broken = await t.call('POST', runsApi.runs(), req);
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: 'spawn EACCES' });
  });

  it('answers 503 when there is no claude binary, while reads still work', async () => {
    const t = setup({ runs: null });
    const res = await t.call('POST', runsApi.runs(), { mode: 'new', cwd: tmp, prompt: 'x' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'The claude command was not found' });
    for (const [method, path] of [
      ['POST', runsApi.message('run-1')],
      ['POST', runsApi.interrupt('run-1')],
      ['DELETE', runsApi.run('run-1')],
      ['POST', runsApi.permission('run-1', 'tu1')],
    ] as const) {
      expect((await t.call(method, path, { prompt: 'x', decision: 'allow' })).status).toBe(503);
    }
    const list = await t.call('GET', runsApi.runs());
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
  });

  it('refuses request bodies over 1 MB with 413', async () => {
    const t = setup();
    const big = await t.call('POST', runsApi.runs(), {
      mode: 'new',
      cwd: tmp,
      prompt: 'x'.repeat(1024 * 1024),
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: expect.stringContaining('1 MB') });
    const fits = await t.call('POST', runsApi.runs(), {
      mode: 'new',
      cwd: tmp,
      prompt: 'x'.repeat(1000 * 1000),
    });
    expect(fits.status).toBe(201);
    expect(t.runs.calls).toHaveLength(1);
  });

  it('refuses an oversized body sent without a length', async () => {
    const t = setup();
    const chunk = new TextEncoder().encode('x'.repeat(256 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await t.app.request(runsApi.message('run-1'), {
      method: 'POST',
      headers: { [TOKEN_HEADER]: t.token, 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(t.runs.calls).toEqual([]);
  });

  it('requires the token', async () => {
    const t = setup();
    const res = await t.app.request(runsApi.runs(), {
      method: 'POST',
      body: JSON.stringify({ mode: 'new', cwd: tmp, prompt: 'x' }),
    });
    expect(res.status).toBe(403);
    expect(t.runs.calls).toEqual([]);
  });
});

describe('run routes', () => {
  async function withIdleRun() {
    const t = setup();
    t.runs.emit({ ...blankRun('run-1'), status: 'idle' });
    return t;
  }

  it('lists runs', async () => {
    const t = await withIdleRun();
    const res = await t.call('GET', runsApi.runs());
    expect(await res.json()).toEqual([{ ...blankRun('run-1'), status: 'idle' }]);
  });

  it('sends a follow-up message', async () => {
    const t = await withIdleRun();
    const res = await t.call('POST', runsApi.message('run-1'), { prompt: 'and now?' });
    expect(res.status).toBe(204);
    expect(t.runs.calls).toEqual([{ method: 'send', args: ['run-1', 'and now?'] }]);
  });

  it('refuses a follow-up while the run is busy with 409, and unknown runs with 404', async () => {
    const t = await withIdleRun();
    t.runs.emit({ ...blankRun('run-1'), status: 'running' });
    const busy = await t.call('POST', runsApi.message('run-1'), { prompt: 'x' });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'Wait for the current reply to finish' });
    expect((await t.call('POST', runsApi.message('nope'), { prompt: 'x' })).status).toBe(404);
  });

  it('rejects a follow-up without a prompt', async () => {
    const t = await withIdleRun();
    expect((await t.call('POST', runsApi.message('run-1'), {})).status).toBe(400);
    expect(t.runs.calls).toEqual([]);
  });

  it('interrupts and closes runs', async () => {
    const t = await withIdleRun();
    expect((await t.call('POST', runsApi.interrupt('run-1'))).status).toBe(204);
    expect((await t.call('DELETE', runsApi.run('run-1'))).status).toBe(204);
    expect(t.runs.calls.map((c) => [c.method, c.args[0]])).toEqual([
      ['interrupt', 'run-1'],
      ['close', 'run-1'],
    ]);
    expect((await t.call('DELETE', runsApi.run('nope'))).status).toBe(404);
  });

  it('forwards permission decisions, including AskUserQuestion answers', async () => {
    const t = await withIdleRun();
    const pending = (id: string) => ({
      id,
      toolName: 'AskUserQuestion',
      input: {},
      questions: [],
      requestedAt: '2026-10-23T02:00:00.000Z',
    });
    t.runs.emit({
      ...blankRun('run-1'),
      status: 'waiting-permission',
      pendingPermissions: [pending('tu1'), pending('tu2')],
    });
    const answer = { decision: 'allow', answers: { 'Which?': ['A', 'B'], 'Why?': 'because' } };
    expect((await t.call('POST', runsApi.permission('run-1', 'tu1'), answer)).status).toBe(204);
    const deny = { decision: 'deny', message: 'not now' };
    expect((await t.call('POST', runsApi.permission('run-1', 'tu2'), deny)).status).toBe(204);
    expect(t.runs.calls).toEqual([
      { method: 'decide', args: ['run-1', 'tu1', answer] },
      { method: 'decide', args: ['run-1', 'tu2', deny] },
    ]);
  });

  it.each([
    ['no decision', {}],
    ['unknown decision', { decision: 'maybe' }],
    ['answers not an object', { decision: 'allow', answers: 'A' }],
    ['answer not text', { decision: 'allow', answers: { q: 1 } }],
    ['message not text', { decision: 'deny', message: 3 }],
  ])('rejects a permission decision with %s', async (_name, body) => {
    const t = await withIdleRun();
    expect((await t.call('POST', runsApi.permission('run-1', 'tu1'), body)).status).toBe(400);
    expect(t.runs.calls).toEqual([]);
  });
});

describe('GET /api/directories', () => {
  it('lists recent session directories that still exist', async () => {
    await mkdir(join(tmp, 'a'));
    await mkdir(join(tmp, 'b'));
    const base = createDemoSessions()[0] as SessionSummary;
    const at = (min: number) => new Date(Date.UTC(2026, 9, 23, 1, min)).toISOString();
    const sessions = [
      { ...base, id: 's1', cwd: join(tmp, 'a'), updatedAt: at(1) },
      { ...base, id: 's2', cwd: join(tmp, 'gone'), updatedAt: at(3) },
      { ...base, id: 's3', cwd: join(tmp, 'b'), updatedAt: at(2) },
    ];
    const t = setup({ sessions, runs: null });
    const res = await t.call('GET', runsApi.directories());
    expect(await res.json()).toEqual({ recent: [join(tmp, 'b'), join(tmp, 'a')] });
  });
});

describe('run events', () => {
  it('sends every current run on connect, then each change', async () => {
    const t = setup();
    t.runs.emit({ ...blankRun('run-1'), status: 'idle' });
    t.runs.emit({ ...blankRun('run-2'), status: 'waiting-permission' });
    const sse = sseReader(await t.call('GET', '/api/events'));
    expect((await sse.next()).event).toBe('sessions');
    expect((await sse.next()).event).toBe('quota');
    const first = [await sse.next(), await sse.next()];
    expect(first.map((e) => [e.event, (e.data as { run: RunState }).run.id])).toEqual([
      ['run', 'run-1'],
      ['run', 'run-2'],
    ]);

    const changed: RunState = { ...blankRun('run-1'), status: 'running' };
    t.runs.emit(changed);
    expect(await sse.next()).toEqual({ event: 'run', data: { type: 'run', run: changed } });
    await sse.cancel();
  });

  it('coalesces a burst for one run to its latest state, without holding other runs back', async () => {
    const t = setup();
    const sse = sseReader(await t.call('GET', '/api/events'));
    await sse.next(); // sessions
    await sse.next(); // quota

    const states = Array.from({ length: 10 }, (_, i) => ({
      ...blankRun('run-1'),
      status: 'running' as const,
      updatedAt: new Date(Date.UTC(2026, 9, 23, 2, 0, i)).toISOString(),
    }));
    for (const s of states) t.runs.emit(s);
    t.runs.emit({ ...blankRun('run-2'), status: 'idle' });
    const later = { ...blankRun('run-1'), status: 'idle' as const };
    t.runs.emit(later); // still the same burst for run-1

    // The pacing itself (≤ 1 per 50 ms per run, never early) is covered in coalescer.test.ts.
    const got = [await sse.next(), await sse.next()];
    expect(got.map((e) => (e.data as { run: RunState }).run)).toEqual([
      later,
      { ...blankRun('run-2'), status: 'idle' },
    ]);
    const next = { ...blankRun('run-1'), status: 'closed' as const };
    t.runs.emit(next);
    expect((await sse.next()).data).toEqual({ type: 'run', run: next });
    await sse.cancel();
  });

  it('releases the run listener, pending timers and the client slot on disconnect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const timersBefore = vi.getTimerCount();
    const t = setup();
    const sse = sseReader(await t.call('GET', '/api/events'));
    await sse.next(); // sessions
    await sse.next(); // quota
    expect(t.runs.listenerCount).toBe(1);
    expect(t.clients.count).toBe(1);

    t.runs.emit({ ...blankRun('run-1'), status: 'running' });
    await vi.advanceTimersByTimeAsync(0);
    await sse.next();
    t.runs.emit({ ...blankRun('run-1'), status: 'idle' }); // inside the gap → trailing timer
    expect(vi.getTimerCount()).toBe(timersBefore + 2); // heartbeat + trailing send

    await sse.cancel();

    // Not vi.waitFor: with fake timers it advances them, which would fire (and hide) a leak.
    for (let i = 0; i < 100 && t.runs.listenerCount > 0; i++)
      await new Promise((r) => setImmediate(r));
    expect(t.runs.listenerCount).toBe(0);
    expect(t.clients.count).toBe(0);
    expect(vi.getTimerCount()).toBe(timersBefore);
  });
});

describe('a permission prompt nested deeper than JSON.stringify can go (real runs, fake claude)', () => {
  const FAKE = join(import.meta.dirname, 'runners', '__tests__', 'fake-claude.mjs');
  const DEPTH = 20_000;
  const DEEP = `${'{"a":'.repeat(DEPTH)}1${'}'.repeat(DEPTH)}`;

  it('is listed and streamed cut, and allowing it sends claude the whole input', async () => {
    const scenario = join(tmp, 'scenario.json');
    const fakeLog = join(tmp, 'fake.log');
    await writeFile(
      scenario,
      JSON.stringify([
        { wait: { type: 'control_request', request: { subtype: 'initialize' } } },
        {
          emit: {
            type: 'control_response',
            response: { subtype: 'success', request_id: '$id', response: {} },
          },
        },
        { wait: { type: 'user' } },
        { emit: { type: 'system', subtype: 'init', session_id: 'sess-deep' } },
        {
          raw: `{"type":"control_request","request_id":"perm-deep","request":{"subtype":"can_use_tool","tool_name":"Bash","input":${DEEP},"tool_use_id":"toolu_deep"}}\n`,
        },
        {
          wait: {
            type: 'control_response',
            response: { request_id: 'perm-deep', response: { behavior: 'allow' } },
          },
        },
        { emit: { type: 'result', subtype: 'success', is_error: false, result: 'done' } },
      ]),
    );
    const runs = new RunManager({
      spawn: spawnClaude,
      claudeBin: FAKE,
      resolveSession: () => null,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO_FILE: scenario, FAKE_CLAUDE_LOG: fakeLog },
    });
    const security = createSecurity();
    const app = createApp({ store: storeWith(), security, runs, log: () => {} });
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { [TOKEN_HEADER]: security.token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const marker = JSON.stringify(TOO_DEEP);
    const sse = sseReader(await call('GET', '/api/events'));
    await sse.next(); // sessions
    await sse.next(); // quota
    const nextRun = async (status: RunState['status']) => {
      for (;;) {
        const e = await sse.next();
        const run = (e.data as { run?: RunState }).run;
        if (e.event === 'run' && run?.status === status) return run;
      }
    };

    const started = await call('POST', runsApi.runs(), { mode: 'new', cwd: tmp, prompt: 'go' });
    expect(started.status).toBe(201);
    const { id } = ((await started.json()) as { run: RunState }).run;

    const waiting = await nextRun('waiting-permission');
    expect(JSON.stringify(waiting.pendingPermissions)).toContain(marker);
    const listed = await call('GET', runsApi.runs());
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain(marker);

    const allowed = await call('POST', runsApi.permission(id, 'toolu_deep'), { decision: 'allow' });
    expect(allowed.status).toBe(204);
    // Claude Code read the answer and finished the turn.
    await nextRun('idle');
    const written = (await readFile(fakeLog, 'utf8'))
      .split('\n')
      .filter((l) => l.includes('"perm-deep"'));
    expect(written).toEqual([
      `{"stdin":{"type":"control_response","response":{"subtype":"success","request_id":"perm-deep","response":{"behavior":"allow","updatedInput":${DEEP}}}}}`,
    ]);
    expect(() => JSON.parse(written[0] as string)).not.toThrow();

    runs.close(id);
    await nextRun('closed');
    await sse.cancel();
  });
});
