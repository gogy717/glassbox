import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../../../src/core/model.js';
import { TOKEN_HEADER } from '../../../src/shared/protocol.js';
import type { RunState } from '../../../src/shared/runs.js';
import { ApiError } from './api';
import {
  createRunsClient,
  failedSessions,
  runForSession,
  waitingSessionIds,
  withWaiting,
} from './runs';

type Call = { url: string; init: RequestInit | undefined };

function fakeServer(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = `${init?.method ?? 'GET'} ${url}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 404 });
    return route(init);
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const header = (c: Call | undefined) => new Headers(c?.init?.headers).get(TOKEN_HEADER);

describe('runs client', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the launch token once and sends it on every write', async () => {
    const calls = fakeServer({
      'GET /api/token': () => json({ token: 'tok-1' }),
      'POST /api/runs': () => json({ run: { id: 'run_1' } }),
      'POST /api/runs/run_1/messages': () => new Response(null, { status: 204 }),
    });
    const client = createRunsClient();
    const run = await client.start({ mode: 'new', cwd: '/w', prompt: 'hi' });
    expect(run.id).toBe('run_1');
    await client.send('run_1', 'again');
    expect(calls.filter((c) => c.url === '/api/token')).toHaveLength(1);
    const writes = calls.filter((c) => c.init?.method === 'POST');
    expect(writes.map(header)).toEqual(['tok-1', 'tok-1']);
    expect(JSON.parse(String(writes[0]?.init?.body))).toEqual({
      mode: 'new',
      cwd: '/w',
      prompt: 'hi',
    });
    expect(new Headers(writes[0]?.init?.headers).get('content-type')).toBe('application/json');
  });

  it('refreshes the token once when the server restarted (403) and retries', async () => {
    let token = 'old';
    const calls = fakeServer({
      'GET /api/token': () => json({ token }),
      'POST /api/runs/r/interrupt': (init) =>
        new Headers(init?.headers).get(TOKEN_HEADER) === 'new'
          ? new Response(null, { status: 204 })
          : json({ error: 'bad token' }, 403),
    });
    const client = createRunsClient();
    await client.token();
    token = 'new';
    await client.interrupt('r');
    expect(calls.filter((c) => c.url === '/api/runs/r/interrupt').map(header)).toEqual([
      'old',
      'new',
    ]);
  });

  it('reports a busy run (409) with the server message', async () => {
    fakeServer({
      'GET /api/token': () => json({ token: 't' }),
      'POST /api/runs/r/messages': () =>
        json({ error: 'Wait for the current reply to finish' }, 409),
    });
    const p = createRunsClient().send('r', 'x');
    await expect(p).rejects.toBeInstanceOf(ApiError);
    await expect(p).rejects.toMatchObject({
      status: 409,
      message: 'Wait for the current reply to finish',
    });
  });

  it('answers a permission prompt, ends a run, and lists runs and directories', async () => {
    const calls = fakeServer({
      'GET /api/token': () => json({ token: 't' }),
      'POST /api/runs/r/permissions/tu%2F1': () => new Response(null, { status: 204 }),
      'DELETE /api/runs/r': () => new Response(null, { status: 204 }),
      'GET /api/runs': () => json([{ id: 'r' }]),
      'GET /api/directories': () => json({ recent: ['/w/a', '/w/b'] }),
    });
    const client = createRunsClient();
    await client.decide('r', 'tu/1', { decision: 'deny', message: 'no' });
    await client.close('r');
    expect(await client.list()).toEqual([{ id: 'r' }]);
    expect(await client.directories()).toEqual(['/w/a', '/w/b']);
    const decide = calls.find((c) => c.url.includes('/permissions/'));
    expect(JSON.parse(String(decide?.init?.body))).toEqual({ decision: 'deny', message: 'no' });
    expect(header(calls.find((c) => c.init?.method === 'DELETE'))).toBe('t');
  });
});

describe('runForSession', () => {
  const run = (id: string, sessionId: string | null, status: RunState['status'], at: string) =>
    ({ id, sessionId, status, updatedAt: `2026-10-23T10:00:${at}.000Z` }) as RunState;

  it('picks the most recently updated run of the session that has not closed', () => {
    const runs = new Map(
      [
        run('a', 's1', 'idle', '01'),
        run('b', 's1', 'running', '05'),
        run('c', 's1', 'closed', '09'),
        run('d', 's2', 'running', '07'),
      ].map((r) => [r.id, r]),
    );
    expect(runForSession(runs, 's1')?.id).toBe('b');
    expect(runForSession(runs, 's3')).toBeNull();
    expect(runForSession(runs, null)).toBeNull();
  });
});

describe('failedSessions', () => {
  const run = (id: string, sessionId: string | null, status: RunState['status'], at: string) =>
    ({
      id,
      sessionId,
      status,
      error: status === 'error' ? `exit ${id}` : null,
      updatedAt: `2026-10-23T10:00:${at}.000Z`,
    }) as RunState;

  it('are the sessions whose latest open run failed, with its error', () => {
    const runs = new Map(
      [
        run('a', 's1', 'error', '05'),
        run('b', 's2', 'error', '01'),
        run('c', 's2', 'idle', '04'),
        run('d', 's3', 'error', '02'),
        run('e', 's3', 'closed', '09'),
        run('f', null, 'error', '03'),
      ].map((r) => [r.id, r]),
    );
    // s2 ran again after its failure; s3's later run closed, which leaves the failure.
    expect([...failedSessions(runs)]).toEqual([
      ['s1', 'exit a'],
      ['s3', 'exit d'],
    ]);
  });
});

describe('waitingSessionIds and withWaiting', () => {
  const ask = { id: 'tu_1', toolName: 'Bash', input: {}, questions: null, requestedAt: '' };
  const run = (id: string, sessionId: string | null, status: RunState['status'], open: number) =>
    ({ id, sessionId, status, pendingPermissions: Array(open).fill(ask) }) as RunState;

  it('are the sessions with a prompt open on a run that has not closed', () => {
    const runs = new Map(
      [
        run('a', 's1', 'waiting-permission', 1),
        run('b', 's2', 'running', 0),
        run('c', 's3', 'closed', 1),
        run('d', null, 'waiting-permission', 1),
        run('e', 's1', 'idle', 0),
      ].map((r) => [r.id, r]),
    );
    expect(waitingSessionIds(runs)).toEqual(['s1']);
  });

  it('say those sessions are waiting, and leave the list as it was when none is', () => {
    const sessions = [
      { id: 's1', live: 'busy' },
      { id: 's2', live: 'busy' },
    ] as SessionSummary[];
    expect(withWaiting(sessions, []).map((s) => s.live)).toEqual(['busy', 'busy']);
    expect(withWaiting(sessions, [])).toBe(sessions);
    expect(withWaiting(sessions, ['s1']).map((s) => s.live)).toEqual(['waiting', 'busy']);
    expect(withWaiting(sessions, ['s1'])[1]).toBe(sessions[1]);
  });
});
