import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDemoQuota,
  createDemoSessions,
  createDemoSnapshot,
  DEMO_SESSION_ID,
} from '../core/fixtures/demo.js';
import type {
  QuotaSnapshot,
  RequestDetail,
  SessionPatch,
  SessionSnapshot,
  SessionSummary,
} from '../core/model.js';
import { api } from '../shared/protocol.js';
import { createFakeAdapter, fakePaths, lines, rec } from './__tests__/fake-adapter.js';
import { sseReader } from './__tests__/sse-reader.js';
import { type AppStore, createApp } from './app.js';
import { TOO_DEEP } from './json.js';
import { createSecurity } from './security.js';
import { SessionStore } from './store.js';

/** A store double backed by the demo fixture that records live subscriptions. */
function stubStore() {
  const snapshot = createDemoSnapshot(new Date('2026-10-23T02:00:00.000Z'));
  const sessions = createDemoSessions(new Date('2026-10-23T02:00:00.000Z'));
  const sessionCbs = new Set<(s: SessionSummary[]) => void>();
  const patchCbs = new Set<(p: SessionPatch) => void>();
  const resetCbs = new Set<(s: SessionSnapshot) => void>();
  const quotaCbs = new Set<(q: QuotaSnapshot[]) => void>();
  const quotas = [createDemoQuota(new Date('2026-10-23T02:00:00.000Z'))];
  const store: AppStore = {
    expectSession: async (id) => id === DEMO_SESSION_ID,
    listQuotas: () => quotas,
    onQuota: (cb) => {
      quotaCbs.add(cb);
      return () => quotaCbs.delete(cb);
    },
    listSessions: () => sessions,
    getSnapshot: async (id) => (id === DEMO_SESSION_ID ? snapshot : null),
    getRequestDetail: async (id, requestId): Promise<RequestDetail | null> =>
      id === DEMO_SESSION_ID && snapshot.requests.some((r) => r.id === requestId)
        ? {
            requestId,
            completeness: 'full',
            notes: [],
            params: { model: 'claude-opus-5-5' },
            system: [],
            tools: [],
            messages: [],
          }
        : null,
    getToolResult: async (id, toolCallId) =>
      id === DEMO_SESSION_ID && toolCallId === 'tu_m1a'
        ? { found: true, result: { stdout: 'src/server/store.ts:41' } }
        : { found: false, result: undefined },
    onSessions: (cb) => {
      sessionCbs.add(cb);
      return () => sessionCbs.delete(cb);
    },
    onPatch: (id, cb, onReset) => {
      if (id !== DEMO_SESSION_ID) throw new Error('subscribed to an unknown session');
      patchCbs.add(cb);
      if (onReset) resetCbs.add(onReset);
      return () => {
        patchCbs.delete(cb);
        if (onReset) resetCbs.delete(onReset);
      };
    },
  };
  const listeners = () => sessionCbs.size + patchCbs.size + resetCbs.size + quotaCbs.size;
  return { store, snapshot, sessions, quotas, sessionCbs, patchCbs, resetCbs, quotaCbs, listeners };
}

let tmp: string | undefined;
afterEach(async () => {
  vi.useRealTimers();
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('REST routes', () => {
  it('lists sessions', async () => {
    const { store, sessions } = stubStore();
    const res = await createApp({ store }).request(api.sessions());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sessions);
  });

  it('returns a snapshot for a session id containing a colon', async () => {
    const { store, snapshot } = stubStore();
    const res = await createApp({ store }).request(api.session(DEMO_SESSION_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(snapshot);
  });

  it('answers 404 with an error body for an unknown session', async () => {
    const { store } = stubStore();
    const res = await createApp({ store }).request(api.session('claude-code:nope'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'session not found' });
  });

  it('returns request details, 404 for an unknown request', async () => {
    const { store } = stubStore();
    const app = createApp({ store });
    const ok = await app.request(api.requestDetail(DEMO_SESSION_ID, 'req_m1'));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as RequestDetail).requestId).toBe('req_m1');
    const missing = await app.request(api.requestDetail(DEMO_SESSION_ID, 'nope'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'request not found' });
  });

  it('returns full tool results, 404 for an unknown tool call', async () => {
    const { store } = stubStore();
    const app = createApp({ store });
    const ok = await app.request(api.toolResult(DEMO_SESSION_ID, 'tu_m1a'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      toolCallId: 'tu_m1a',
      result: { stdout: 'src/server/store.ts:41' },
    });
    const missing = await app.request(api.toolResult(DEMO_SESSION_ID, 'nope'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'tool call not found' });
  });

  it('answers unknown api paths with a json 404', async () => {
    const { store } = stubStore();
    const res = await createApp({ store }).request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('serves the per-launch token', async () => {
    const { store } = stubStore();
    const security = createSecurity();
    const res = await createApp({ store, security }).request(api.token(), {
      headers: { host: '127.0.0.1:7788' },
    });
    expect(await res.json()).toEqual({ token: security.token });
  });

  it('guards every api route, the event stream included, against foreign hosts', async () => {
    const { store, listeners } = stubStore();
    const app = createApp({ store });
    for (const path of [
      api.token(),
      api.quota(),
      api.sessions(),
      api.session(DEMO_SESSION_ID),
      api.events(DEMO_SESSION_ID),
    ]) {
      const res = await app.request(path, { headers: { host: 'evil.example:7788' } });
      expect(res.status).toBe(403);
    }
    expect(listeners()).toBe(0);
  });

  it('turns a store failure into a json 500', async () => {
    const { store } = stubStore();
    store.getSnapshot = async () => {
      throw new Error('disk on fire');
    };
    const res = await createApp({ store, log: () => {} }).request(api.session(DEMO_SESSION_ID));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'disk on fire' });
  });
});

describe('static files', () => {
  async function site() {
    tmp = await mkdtemp(join(tmpdir(), 'glassbox-web-'));
    await mkdir(join(tmp, 'assets'));
    await writeFile(join(tmp, 'index.html'), '<!doctype html><title>glassbox</title>');
    await writeFile(join(tmp, 'assets', 'app.js'), 'console.log(1)');
    return tmp;
  }

  it('serves built files and falls back to index.html for client routes', async () => {
    const { store } = stubStore();
    const app = createApp({ store, staticDir: await site() });

    const js = await app.request('/assets/app.js');
    expect(js.status).toBe(200);
    expect(await js.text()).toBe('console.log(1)');

    for (const path of ['/', '/sessions/claude-code%3Aabc']) {
      const page = await app.request(path);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(await page.text()).toContain('<title>glassbox</title>');
    }
  });

  it('serves the self-hosted fonts as fonts', async () => {
    const { store } = stubStore();
    const dir = await site();
    await mkdir(join(dir, 'fonts'));
    await writeFile(join(dir, 'fonts', 'IBMPlexMono-Regular-Latin1.woff2'), 'wOF2');
    const res = await createApp({ store, staticDir: dir }).request(
      '/fonts/IBMPlexMono-Regular-Latin1.woff2',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('font/woff2');
    expect(await res.text()).toBe('wOF2');
  });

  it('keeps json 404s for unknown api paths when serving static files', async () => {
    const { store } = stubStore();
    const res = await createApp({ store, staticDir: await site() }).request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});

describe('GET /api/events', () => {
  it('sends the session list, the quota, then the snapshot, then patches and rebuild snapshots', async () => {
    const t = stubStore();
    const res = await createApp({ store: t.store }).request(api.events(DEMO_SESSION_ID));
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const sse = sseReader(res);

    const first = await sse.next();
    expect(first.event).toBe('sessions');
    expect(first.data).toEqual({ type: 'sessions', sessions: t.sessions });

    expect(await sse.next()).toEqual({ event: 'quota', data: { type: 'quota', quotas: t.quotas } });

    const second = await sse.next();
    expect(second.event).toBe('snapshot');
    expect(second.data).toEqual({
      type: 'snapshot',
      sessionId: DEMO_SESSION_ID,
      snapshot: t.snapshot,
    });

    const patch: SessionPatch = {
      ...emptyPatch(t.snapshot),
      requests: [t.snapshot.requests[0]],
    } as SessionPatch;
    for (const cb of t.patchCbs) cb(patch);
    expect(await sse.next()).toEqual({
      event: 'patch',
      data: { type: 'patch', sessionId: DEMO_SESSION_ID, patch },
    });

    const list = t.sessions.slice(1);
    for (const cb of t.sessionCbs) cb(list);
    expect(await sse.next()).toEqual({
      event: 'sessions',
      data: { type: 'sessions', sessions: list },
    });

    const rebuilt = { ...t.snapshot, requests: [] };
    for (const cb of t.resetCbs) cb(rebuilt);
    expect(await sse.next()).toEqual({
      event: 'snapshot',
      data: { type: 'snapshot', sessionId: DEMO_SESSION_ID, snapshot: rebuilt },
    });
    await sse.cancel();
  });

  it('streams only session lists without a session id, and for an unknown one', async () => {
    for (const path of [api.events(), api.events('claude-code:nope')]) {
      const t = stubStore();
      const sse = sseReader(await createApp({ store: t.store }).request(path));
      expect((await sse.next()).event).toBe('sessions');
      expect((await sse.next()).event).toBe('quota');
      // The stub reports unknown ids as never appearing.
      if (path !== api.events()) expect((await sse.next()).event).toBe('session-missing');
      expect(t.patchCbs.size).toBe(0);
      for (const cb of t.sessionCbs) cb([]);
      expect(await sse.next()).toEqual({
        event: 'sessions',
        data: { type: 'sessions', sessions: [] },
      });
      await sse.cancel();
    }
  });

  it('sends heartbeats', async () => {
    const t = stubStore();
    const sse = sseReader(
      await createApp({ store: t.store, heartbeatMs: 20 }).request(api.events()),
    );
    expect((await sse.next()).event).toBe('sessions');
    expect((await sse.next()).event).toBe('quota');
    const hb = await sse.next();
    expect(hb.event).toBe('heartbeat');
    expect(Number.isNaN(Date.parse((hb.data as { now: string }).now))).toBe(false);
    await sse.cancel();
  });

  it('releases every listener and timer when the client disconnects', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const timersBefore = vi.getTimerCount();
    const t = stubStore();
    const sse = sseReader(await createApp({ store: t.store }).request(api.events(DEMO_SESSION_ID)));
    await sse.next(); // sessions
    await sse.next(); // quota
    await sse.next(); // snapshot
    expect(t.listeners()).toBe(4);
    expect(vi.getTimerCount()).toBe(timersBefore + 1);

    await sse.cancel();

    await vi.waitFor(() => expect(t.listeners()).toBe(0));
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it('releases listeners when the client leaves while the snapshot is loading', async () => {
    const t = stubStore();
    let release: () => void = () => {};
    const getSnapshot = t.store.getSnapshot;
    t.store.getSnapshot = (id) =>
      new Promise((resolve) => {
        release = () => resolve(getSnapshot(id));
      });
    const sse = sseReader(await createApp({ store: t.store }).request(api.events(DEMO_SESSION_ID)));
    await sse.next();

    await sse.cancel();
    release();

    await vi.waitFor(() => expect(t.listeners()).toBe(0));
  });
});

function emptyPatch(s: SessionSnapshot): SessionPatch {
  return {
    session: s.session,
    agents: [],
    turns: [],
    requests: [],
    toolCalls: [],
    workflows: [],
    diagnostics: null,
  };
}

describe('with a real SessionStore', () => {
  it('streams the snapshot and then patches for appended records', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'glassbox-app-store-'));
    const p = fakePaths(tmp, 'proj', 'a');
    await mkdir(p.projectDir, { recursive: true });
    await writeFile(p.main, lines(rec.req('r1', '2026-10-23T01:00:00.000Z')));
    const store = new SessionStore({
      adapters: [createFakeAdapter(tmp)],
      discoverMs: 50,
      liveMs: 50,
      pollMs: 50,
    });
    await store.start();
    try {
      const sse = sseReader(await createApp({ store }).request(api.events(p.id)));
      expect((await sse.next()).event).toBe('sessions');
      expect(await sse.next()).toEqual({ event: 'quota', data: { type: 'quota', quotas: [] } });
      const snap = await sse.next();
      expect(snap.event).toBe('snapshot');
      expect(
        (snap.data as { snapshot: SessionSnapshot }).snapshot.requests.map((r) => r.id),
      ).toEqual(['r1']);

      await appendFile(p.main, lines(rec.req('r2', '2026-10-23T01:01:00.000Z')));

      for (;;) {
        const e = await sse.next();
        if (e.event !== 'patch') continue;
        expect((e.data as { patch: SessionPatch }).patch.requests.map((r) => r.id)).toEqual(['r2']);
        break;
      }
      await sse.cancel();
    } finally {
      await store.stop();
    }
  });
});

describe('a transcript with values nested deeper than JSON.stringify can go', () => {
  const DEPTH = 20_000;
  // Cheap to write and fine for JSON.parse, but JSON.stringify overflows the stack on it.
  const DEEP_JSON = `${'{"a":'.repeat(DEPTH)}1${'}'.repeat(DEPTH)}`;
  const PLACEHOLDER = 'deep-value-here';
  const deepen = (line: string) => line.split(JSON.stringify(PLACEHOLDER)).join(DEEP_JSON);
  const at = (min: number) => `2026-10-23T01:0${min}:00.000Z`;
  const marker = JSON.stringify(TOO_DEEP);

  async function deepSession() {
    tmp = await mkdtemp(join(tmpdir(), 'glassbox-app-deep-'));
    const p = fakePaths(tmp, 'proj', 'a');
    await mkdir(p.projectDir, { recursive: true });
    await writeFile(
      p.main,
      lines(
        ...[
          rec.req('r1', at(1), 10, PLACEHOLDER),
          rec.tool('tu1', 'r1', 'mcp__x__nested', PLACEHOLDER),
          rec.result('tu1', PLACEHOLDER),
        ].map(deepen),
      ),
    );
    const store = new SessionStore({
      adapters: [createFakeAdapter(tmp)],
      discoverMs: 50,
      liveMs: 50,
      pollMs: 50,
    });
    await store.start();
    return { p, store, app: createApp({ store }) };
  }

  it('answers the snapshot, request detail and tool result with the deep part cut', async () => {
    const { p, store, app } = await deepSession();
    try {
      const snap = await app.request(api.session(p.id));
      expect(snap.status).toBe(200);
      const snapText = await snap.text();
      expect(snapText).toContain(marker);
      expect((JSON.parse(snapText) as SessionSnapshot).toolCalls.map((t) => t.id)).toEqual(['tu1']);

      const detail = await app.request(api.requestDetail(p.id, 'r1'));
      expect(detail.status).toBe(200);
      expect(await detail.text()).toContain(marker);

      const result = await app.request(api.toolResult(p.id, 'tu1'));
      expect(result.status).toBe(200);
      expect(await result.text()).toContain(marker);
    } finally {
      await store.stop();
    }
  });

  it('streams the snapshot, and patches that bring more deep values', async () => {
    const { p, store, app } = await deepSession();
    try {
      const sse = sseReader(await app.request(api.events(p.id)));
      expect((await sse.next()).event).toBe('sessions');
      expect((await sse.next()).event).toBe('quota');
      const snap = await sse.next();
      expect(snap.event).toBe('snapshot');
      expect(JSON.stringify(snap.data)).toContain(marker);

      await appendFile(p.main, lines(deepen(rec.tool('tu2', 'r1', 'mcp__x__nested', PLACEHOLDER))));
      for (;;) {
        const e = await sse.next();
        if (e.event !== 'patch') continue;
        const { patch } = e.data as { patch: SessionPatch };
        if (!patch.toolCalls.some((t) => t.id === 'tu2')) continue;
        expect(JSON.stringify(patch)).toContain(marker);
        break;
      }
      await sse.cancel();
    } finally {
      await store.stop();
    }
  });
});

describe('quota', () => {
  it('serves the current quotas', async () => {
    const t = stubStore();
    const res = await createApp({ store: t.store }).request(api.quota());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quotas: t.quotas });
  });

  it('pushes quota changes to every connection', async () => {
    const t = stubStore();
    const sse = sseReader(await createApp({ store: t.store }).request(api.events()));
    await sse.next(); // sessions
    await sse.next(); // quota

    const changed = [{ ...(t.quotas[0] as QuotaSnapshot), stale: true }];
    for (const cb of t.quotaCbs) cb(changed);

    expect(await sse.next()).toEqual({ event: 'quota', data: { type: 'quota', quotas: changed } });
    await sse.cancel();
  });
});

describe('subscribing to a session that is not known yet', () => {
  /** A stub whose session `late` appears when `appear()` is called. */
  function lateStore() {
    const t = stubStore();
    const late = { ...t.snapshot, session: { ...t.snapshot.session, id: 'claude-code:late' } };
    let known = false;
    let found: (v: boolean) => void = () => {};
    const waiting = new Promise<boolean>((r) => {
      found = r;
    });
    t.store.getSnapshot = async (id) => (id === 'claude-code:late' && known ? late : null);
    t.store.expectSession = (id) => (id === 'claude-code:late' ? waiting : Promise.resolve(false));
    t.store.onPatch = (_id, cb) => {
      t.patchCbs.add(cb);
      return () => t.patchCbs.delete(cb);
    };
    const appear = () => {
      known = true;
      found(true);
    };
    return { ...t, late, appear };
  }

  it('sends the snapshot as soon as the session appears', async () => {
    const t = lateStore();
    const sse = sseReader(
      await createApp({ store: t.store }).request(api.events('claude-code:late')),
    );
    expect((await sse.next()).event).toBe('sessions');
    expect((await sse.next()).event).toBe('quota');

    t.appear();

    expect(await sse.next()).toEqual({
      event: 'snapshot',
      data: { type: 'snapshot', sessionId: 'claude-code:late', snapshot: t.late },
    });
    expect(t.patchCbs.size).toBe(1);
    await sse.cancel();
  });

  it('keeps streaming while it waits', async () => {
    const t = lateStore();
    const sse = sseReader(
      await createApp({ store: t.store, heartbeatMs: 20 }).request(api.events('claude-code:late')),
    );
    await sse.next(); // sessions
    await sse.next(); // quota
    expect((await sse.next()).event).toBe('heartbeat');
    for (const cb of t.sessionCbs) cb([]);
    let e = await sse.next();
    while (e.event === 'heartbeat') e = await sse.next();
    expect(e.event).toBe('sessions');
    await sse.cancel();
  });

  it('subscribes to nothing if the client left before the session appeared', async () => {
    const t = lateStore();
    const sse = sseReader(
      await createApp({ store: t.store }).request(api.events('claude-code:late')),
    );
    await sse.next();
    await sse.cancel();
    t.appear();
    await vi.waitFor(() => expect(t.listeners()).toBe(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(t.patchCbs.size).toBe(0);
  });
});

describe('a session that does not show up in time', () => {
  function missingStore() {
    const t = stubStore();
    const late = { ...t.snapshot, session: { ...t.snapshot.session, id: 'claude-code:slow' } };
    let known = false;
    const waits: number[] = [];
    t.store.getSnapshot = async (id) => (id === 'claude-code:slow' && known ? late : null);
    t.store.expectSession = async (_id, timeoutMs) => {
      waits.push(timeoutMs ?? -1);
      return false;
    };
    t.store.onPatch = (_id, cb) => {
      t.patchCbs.add(cb);
      return () => t.patchCbs.delete(cb);
    };
    const appear = () => {
      known = true;
      for (const cb of t.sessionCbs) cb([late.session]);
    };
    return { ...t, late, appear, waits };
  }

  it('says so once, then keeps streaming', async () => {
    const t = missingStore();
    const app = createApp({ store: t.store, sessionWaitMs: 1234 });
    const sse = sseReader(await app.request(api.events('claude-code:slow')));
    await sse.next(); // sessions
    await sse.next(); // quota
    expect(await sse.next()).toEqual({
      event: 'session-missing',
      data: { type: 'session-missing', sessionId: 'claude-code:slow' },
    });
    expect(t.waits).toEqual([1234]);
    for (const cb of t.sessionCbs) cb([]);
    expect((await sse.next()).event).toBe('sessions');
    await sse.cancel();
  });

  it('subscribes to nothing when the client leaves while a late snapshot loads', async () => {
    const t = missingStore();
    const sse = sseReader(
      await createApp({ store: t.store }).request(api.events('claude-code:slow')),
    );
    await sse.next(); // sessions
    await sse.next(); // quota
    expect((await sse.next()).event).toBe('session-missing');
    let finish: () => void = () => {};
    t.store.getSnapshot = () =>
      new Promise((resolve) => {
        finish = () => resolve(t.late);
      });

    t.appear(); // attach starts, snapshot still loading
    await sse.cancel();
    await vi.waitFor(() => expect(t.listeners()).toBe(0));
    finish();
    await new Promise((r) => setTimeout(r, 50));

    expect(t.patchCbs.size).toBe(0);
  });

  it('still sends the snapshot if the session turns up later', async () => {
    const t = missingStore();
    const sse = sseReader(
      await createApp({ store: t.store }).request(api.events('claude-code:slow')),
    );
    await sse.next(); // sessions
    await sse.next(); // quota
    expect((await sse.next()).event).toBe('session-missing');

    t.appear();

    let e = await sse.next();
    while (e.event === 'sessions') e = await sse.next();
    expect(e).toEqual({
      event: 'snapshot',
      data: { type: 'snapshot', sessionId: 'claude-code:slow', snapshot: t.late },
    });
    await sse.cancel();
    await vi.waitFor(() => expect(t.listeners()).toBe(0));
  });
});

describe('security headers', () => {
  const EXPECTED: Record<string, string> = {
    'x-frame-options': 'DENY',
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  };

  async function siteApp() {
    tmp = await mkdtemp(join(tmpdir(), 'glassbox-headers-'));
    await mkdir(join(tmp, 'assets'));
    await writeFile(join(tmp, 'index.html'), '<!doctype html><title>glassbox</title>');
    await writeFile(join(tmp, 'assets', 'app.js'), 'console.log(1)');
    const t = stubStore();
    const store = {
      ...t.store,
      getToolResult: async () => {
        throw new Error('boom');
      },
    };
    return createApp({ store, staticDir: tmp, log: () => {} });
  }

  it.each([
    ['an API read', api.sessions(), {}, 200],
    ['the SPA page', '/', {}, 200],
    ['a client route (SPA fallback)', '/s/claude-code%3Aabc', {}, 200],
    ['a static asset', '/assets/app.js', {}, 200],
    ['an unknown API path', '/api/nope', {}, 404],
    ['a refused host', api.sessions(), { headers: { host: 'evil.example' } }, 403],
    ['a server error', api.toolResult(DEMO_SESSION_ID, 'tu_m1a'), {}, 500],
    ['a refused write', '/api/runs', { method: 'POST' }, 403],
  ] as const)('are on %s', async (_name, path, init, status) => {
    const res = await (await siteApp()).request(path, init as RequestInit);
    expect(res.status).toBe(status);
    for (const [name, value] of Object.entries(EXPECTED)) expect(res.headers.get(name)).toBe(value);
  });

  it('are on the event stream', async () => {
    const res = await (await siteApp()).request(api.events());
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    for (const [name, value] of Object.entries(EXPECTED)) expect(res.headers.get(name)).toBe(value);
    await res.body?.cancel();
  });
});
