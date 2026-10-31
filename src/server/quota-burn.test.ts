import { describe, expect, it } from 'vitest';
import { createDemoSideSnapshots } from '../core/fixtures/demo.js';
import type { ModelRequest, SessionSnapshot, TokenUsage } from '../core/model.js';
import { emptyUsage } from '../core/usage.js';
import { burnPath, type QuotaBurn } from '../shared/quota-burn.js';
import { type AppStore, createApp } from './app.js';
import { QuotaBurnService } from './quota-burn.js';
import type { WeekStore } from './week.js';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (t: number) => new Date(t).toISOString();
const SINCE = NOW - 3 * HOUR;

const use = (input: number, cacheRead = 0, output = 0): TokenUsage => ({
  ...emptyUsage(),
  input,
  cacheRead,
  output,
});

/** A finished request `minAgo` minutes before NOW. */
function req(
  id: string,
  minAgo: number,
  usage: TokenUsage | null,
  model: string | null = 'claude-x',
): ModelRequest {
  const t = NOW - minAgo * MIN;
  return {
    id,
    agentId: 'main',
    turnId: null,
    index: 1,
    model,
    effort: null,
    startedAt: iso(t),
    firstBlockAt: null,
    endedAt: usage ? iso(t + 5_000) : null,
    status: usage ? 'complete' : 'in-flight',
    stopReason: null,
    usage,
    blocks: [],
    toolCallIds: [],
    hasDetail: false,
    error: null,
  };
}

/** A synthetic session of `agent`, last written `updatedMinAgo` minutes before NOW. */
function session(
  id: string,
  agent: string,
  requests: ModelRequest[],
  o: { updatedMinAgo?: number; live?: 'busy' | 'idle' | 'closed'; title?: string } = {},
): SessionSnapshot {
  const [base] = createDemoSideSnapshots(new Date(NOW));
  if (!base) throw new Error('no side session');
  return {
    ...base,
    session: {
      ...base.session,
      id,
      agent,
      title: o.title ?? `Task ${id}`,
      project: 'demo-project',
      cwd: '/home/demo/dev/demo-project',
      updatedAt: iso(NOW - (o.updatedMinAgo ?? 1) * MIN),
      live: o.live ?? 'closed',
    },
    agents: [],
    turns: [],
    toolCalls: [],
    workflows: [],
    requests,
  };
}

function storeOf(snaps: SessionSnapshot[]) {
  const reads: string[] = [];
  const store: WeekStore = {
    weekSessions: () => snaps.map((s) => s.session),
    readSession: async (id) => {
      reads.push(id);
      const snap = snaps.find((s) => s.session.id === id);
      return snap ? { snapshot: structuredClone(snap), bytes: 100 } : null;
    },
  };
  return { store, reads };
}

describe('who used the plan window', () => {
  const snaps = () => [
    session('a', 'claude-code', [
      req('a1', 30, use(100, 1000, 50)),
      // Before the window began: not counted.
      req('a0', 4 * 60, use(99_999)),
    ]),
    session('b', 'claude-code', [req('b1', 10, use(300)), req('b2', 2, null)]),
    session('c', 'claude-code', [req('c1', 60, use(50))]),
  ];

  it('counts each session’s requests since the window began, its tokens by kind and its share', async () => {
    const { store } = storeOf(snaps());
    const burn = await new QuotaBurnService(store, { now: () => NOW }).compute('anthropic', SINCE);
    expect(burn.provider).toBe('anthropic');
    expect(burn.since).toBe(SINCE);
    expect(burn.asOf).toBe(NOW);
    expect(burn.tokens).toBe(1150 + 300 + 50);
    expect(burn.sessions.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    const [a, b] = burn.sessions;
    expect(a?.usage).toMatchObject({ input: 100, cacheRead: 1000, output: 50 });
    expect(a?.tokens).toBe(1150);
    expect(a?.requests).toBe(1);
    expect(a?.title).toBe('Task a');
    // The request still under way counts as a request, with no tokens yet.
    expect(b?.requests).toBe(2);
    expect(b?.tokens).toBe(300);
    const sum = burn.sessions.reduce((n, s) => n + s.share, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(a?.share).toBeCloseTo(1150 / 1500, 10);
  });

  it('leaves out sessions of another provider’s CLI, and reads none of them', async () => {
    const { store, reads } = storeOf([
      ...snaps(),
      session('x', 'codex', [req('x1', 5, use(10_000), 'gpt-5')]),
      session('g', 'grok', [req('g1', 5, use(10_000), 'grok-4')]),
    ]);
    const service = new QuotaBurnService(store, { now: () => NOW });
    const burn = await service.compute('anthropic', SINCE);
    expect(burn.sessions.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(reads).not.toContain('x');
    expect(reads).not.toContain('g');
    const openai = await service.compute('openai', SINCE);
    expect(openai.sessions.map((s) => s.id)).toEqual(['x']);
    expect(openai.sessions[0]?.share).toBe(1);
  });

  it('counts a request of a CLI that talks to any provider against the provider its model names', async () => {
    const { store } = storeOf([
      session('p', 'oh-my-pi', [
        req('p1', 5, use(400), 'claude-sonnet-4-5'),
        req('p2', 5, use(9_000), 'grok-code-fast-1'),
        req('p3', 5, use(9_000), null),
      ]),
    ]);
    const service = new QuotaBurnService(store, { now: () => NOW });
    const anthropic = await service.compute('anthropic', SINCE);
    expect(anthropic.sessions.map((s) => [s.id, s.tokens, s.requests])).toEqual([['p', 400, 1]]);
    const xai = await service.compute('xai', SINCE);
    expect(xai.sessions.map((s) => [s.id, s.tokens])).toEqual([['p', 9_000]]);
  });

  it('reads no session last written before the window began, unless it is running', async () => {
    const { store, reads } = storeOf([
      session('old', 'claude-code', [req('o1', 300, use(5))], { updatedMinAgo: 4 * 60 }),
      session('run', 'claude-code', [req('r1', 20, use(7))], {
        updatedMinAgo: 4 * 60,
        live: 'busy',
      }),
    ]);
    const burn = await new QuotaBurnService(store, { now: () => NOW }).compute('anthropic', SINCE);
    expect(reads).toEqual(['run']);
    expect(burn.sessions.map((s) => s.id)).toEqual(['run']);
  });

  it('reads a finished session once, and again when it changes', async () => {
    const list = snaps();
    const { store, reads } = storeOf(list);
    const service = new QuotaBurnService(store, { now: () => NOW });
    await service.compute('anthropic', SINCE);
    await service.compute('anthropic', SINCE - HOUR);
    expect(reads.filter((r) => r === 'a')).toHaveLength(1);
    const [a] = list;
    if (!a) throw new Error('no session');
    a.session = { ...a.session, updatedAt: iso(NOW) };
    a.requests = [...a.requests, req('a2', 1, use(1))];
    const burn = await service.compute('anthropic', SINCE);
    expect(reads.filter((r) => r === 'a')).toHaveLength(2);
    expect(burn.sessions.find((s) => s.id === 'a')?.requests).toBe(2);
  });

  it('answers shares of 0 and no session when nothing was used', async () => {
    const { store } = storeOf([]);
    const burn = await new QuotaBurnService(store, { now: () => NOW }).compute('anthropic', SINCE);
    expect(burn).toEqual({
      provider: 'anthropic',
      since: SINCE,
      asOf: NOW,
      sessions: [],
      tokens: 0,
      counted: 'tokens',
    });
  });
});

describe('who used a window of a CLI that reports no usage', () => {
  it('shares it by requests, and says so', async () => {
    const { store } = storeOf([
      session('g', 'grok', [req('g1', 5, null), req('g2', 4, null), req('g3', 3, null)]),
      session('h', 'grok', [req('h1', 5, null)]),
    ]);
    const burn = await new QuotaBurnService(store, { now: () => NOW }).compute('xai', SINCE);
    expect(burn.counted).toBe('requests');
    expect(burn.sessions.map((s) => [s.id, s.share])).toEqual([
      ['g', 0.75],
      ['h', 0.25],
    ]);
  });
});

describe('GET /api/quota/burn', () => {
  function burnApp() {
    const { store } = storeOf([
      session('a', 'claude-code', [req('a1', 4 * 60, use(100)), req('a2', 30, use(10))]),
    ]);
    const burn = new QuotaBurnService(store, { now: () => NOW });
    return createApp({ store: {} as AppStore, burn, log: () => {}, now: () => NOW });
  }

  it('answers the window asked for', async () => {
    const res = await burnApp().request(burnPath('anthropic', SINCE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as QuotaBurn;
    expect(body.since).toBe(SINCE);
    expect(body.sessions.map((s) => s.tokens)).toEqual([10]);
  });

  it('covers the last 5 hours when no window is given', async () => {
    const res = await burnApp().request('/api/quota/burn?provider=anthropic');
    expect(res.status).toBe(200);
    const body = (await res.json()) as QuotaBurn;
    expect(body.since).toBe(NOW - 5 * HOUR);
    expect(body.sessions.map((s) => s.tokens)).toEqual([110]);
  });

  it('takes an ISO time too, and turns away a bad provider or time', async () => {
    const app = burnApp();
    const ok = await app.request(`/api/quota/burn?provider=anthropic&since=${iso(SINCE)}`);
    expect(((await ok.json()) as QuotaBurn).since).toBe(SINCE);
    expect((await app.request('/api/quota/burn')).status).toBe(400);
    expect((await app.request('/api/quota/burn?provider=a%20b')).status).toBe(400);
    expect((await app.request('/api/quota/burn?provider=anthropic&since=soon')).status).toBe(400);
    expect(
      (await app.request(`/api/quota/burn?provider=anthropic&since=${NOW + HOUR}`)).status,
    ).toBe(400);
  });

  it('is not found when the store keeps no sessions to read', async () => {
    const app = createApp({ store: {} as AppStore, log: () => {} });
    expect((await app.request('/api/quota/burn?provider=anthropic')).status).toBe(404);
  });
});
