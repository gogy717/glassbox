import { existsSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoQuota, createDemoSessions } from '../core/fixtures/demo.js';
import { checkSnapshot } from '../core/invariants.js';
import type {
  QuotaSnapshot,
  SessionPatch,
  SessionSnapshot,
  SessionSummary,
} from '../core/model.js';
import { hourTotal, ratePerMinute, rateSeries, type TokenRate } from '../shared/rate.js';
import { applyPatch } from './__tests__/apply-patch.js';
import {
  createFakeAdapter,
  createFakeDbAdapter,
  encodeFake,
  FAKE_DB_AGENT,
  type FakeAdapter,
  type FakeDbAdapter,
  fakePaths,
  lines,
  rec,
} from './__tests__/fake-adapter.js';
import { listedSummary, SessionStore, type SessionStoreOptions } from './store.js';

let root: string;
let fake: FakeAdapter;
let store: SessionStore | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'glassbox-store-'));
  fake = createFakeAdapter(root);
});

afterEach(async () => {
  await store?.stop();
  store = undefined;
  await rm(root, { recursive: true, force: true });
});

const T = (min: number) => new Date(Date.UTC(2026, 9, 23, 1, min)).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const setLive = (states: Record<string, string>) =>
  writeFile(join(root, 'live.json'), JSON.stringify(states));

/** A session whose main transcript holds one request per `outs` entry. */
async function session(nativeId: string, ...records: string[]) {
  const p = fakePaths(root, 'proj', nativeId);
  await put(p.main, lines(...records));
  return p;
}

async function startStore(opts: Partial<SessionStoreOptions> = {}) {
  store = new SessionStore({
    adapters: [fake],
    discoverMs: 50,
    liveMs: 50,
    pollMs: 50,
    sessionsMs: 20,
    ...opts,
  });
  await store.start();
  return store;
}

const ids = (items: { id: string }[]) => items.map((i) => i.id).sort();

describe('SessionStore', () => {
  it('lists busy and waiting sessions first, then the most recently updated', async () => {
    await session('a', rec.req('ra', T(10)));
    await session('b', rec.req('rb', T(1)));
    await session('c', rec.req('rc', T(20)));
    await session('d', rec.req('rd', T(5)));
    await setLive({ a: 'idle', b: 'busy', d: 'waiting' });
    const s = await startStore();

    expect(s.listSessions().map((x) => [x.nativeId, x.live])).toEqual([
      ['d', 'waiting'],
      ['b', 'busy'],
      ['c', 'closed'],
      ['a', 'idle'],
    ]);
  });

  it('opens a session on demand, feeding its files in dependency order', async () => {
    const p = await session('a', rec.req('r1', T(1), 10));
    await put(p.subagent('s1'), lines(rec.req('r2', T(2), 20)));
    await put(p.subagentMeta('s1'), JSON.stringify({ label: 'Explore' }));
    await put(p.journal('wf_1'), lines(rec.started('w1', 'recon:live')));
    await put(p.wfAgent('wf_1', 'w1'), lines(rec.req('r3', T(3), 30)));
    await put(p.wfAgentMeta('wf_1', 'w1'), JSON.stringify({ label: 'recon:live' }));
    await put(p.wfState('wf_1'), JSON.stringify({ status: 'completed' }));
    const s = await startStore();

    const snap = (await s.getSnapshot(p.id)) as SessionSnapshot;
    expect(ids(snap.requests)).toEqual(['r1', 'r2', 'r3']);
    expect(snap.agents.find((a) => a.id === 's1')?.label).toBe('Explore');
    expect(checkSnapshot(snap)).toEqual([]);
    expect(fake.parsersFor('a')[0]?.ingested).toEqual([
      'main',
      'subagent-meta',
      'subagent',
      'workflow-state',
      'workflow-journal',
      'workflow-agent-meta',
      'workflow-agent',
    ]);

    const listed = s.listSessions().find((x) => x.id === p.id) as SessionSummary;
    expect(listed.usage?.output).toBe(60);
    expect(listed.counts?.requests).toBe(3);
  });

  it('opens a session whose json file nests deeper than JSON.stringify can go', async () => {
    const depth = 20_000;
    const deep = `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
    const p = await session('a', rec.req('r1', T(1)));
    await put(p.subagent('s1'), lines(rec.req('r2', T(2))));
    await put(p.subagentMeta('s1'), `{"label":"Explore","extra":${deep}}`);
    const s = await startStore();

    const snap = (await s.getSnapshot(p.id)) as SessionSnapshot;
    expect(snap.agents.find((a) => a.id === 's1')?.label).toBe('Explore');

    // Still noticed when it changes.
    await put(p.subagentMeta('s1'), `{"label":"Plan","extra":${deep}}`);
    await vi.waitFor(
      async () =>
        expect((await s.getSnapshot(p.id))?.agents.find((a) => a.id === 's1')?.label).toBe('Plan'),
      { timeout: 3000 },
    );
  });

  it('returns null for an unknown session', async () => {
    const s = await startStore();
    expect(await s.getSnapshot('fake:nope')).toBeNull();
    expect(await s.getRequestDetail('fake:nope', 'r1')).toBeNull();
    expect(await s.getToolResult('fake:nope', 'tu1')).toEqual({ found: false, result: undefined });
  });

  it('serves request details and full tool results', async () => {
    const p = await session(
      'a',
      rec.req('r1', T(1)),
      rec.tool('tu1', 'r1'),
      rec.result('tu1', 'hello'),
    );
    const s = await startStore();

    expect((await s.getRequestDetail(p.id, 'r1'))?.requestId).toBe('r1');
    expect(await s.getRequestDetail(p.id, 'nope')).toBeNull();
    expect(await s.getToolResult(p.id, 'tu1')).toEqual({ found: true, result: 'hello' });
    expect(await s.getToolResult(p.id, 'nope')).toEqual({ found: false, result: undefined });
  });

  it('turns appended records into a patch and an updated session list', async () => {
    const p = await session('a', rec.req('r1', T(1), 10));
    const s = await startStore();
    await s.getSnapshot(p.id);
    const patches: SessionPatch[] = [];
    const lists: SessionSummary[][] = [];
    s.onPatch(p.id, (x) => patches.push(x));
    s.onSessions((x) => lists.push(x));

    await appendFile(p.main, lines(rec.req('r2', T(2), 5)));

    await vi.waitFor(() => expect(patches.flatMap((x) => ids(x.requests))).toContain('r2'), {
      timeout: 5000,
    });
    expect(patches.at(-1)?.session.usage?.output).toBe(15);
    await vi.waitFor(
      () => expect(lists.at(-1)?.find((x) => x.id === p.id)?.usage?.output).toBe(15),
      { timeout: 5000 },
    );
  });

  it('folds a burst of appends into at most two patches, losing nothing', async () => {
    // The ≤ 1-per-patchMs pacing itself is proven with fake timers in coalescer.test.ts; here
    // a window far wider than the burst keeps the count independent of machine load.
    const p = await session('a', rec.req('r0', T(0)));
    const s = await startStore({ patchMs: 3000 });
    await s.getSnapshot(p.id);
    let patches = 0;
    const seen = new Set<string>();
    s.onPatch(p.id, (x) => {
      patches++;
      for (const r of x.requests) seen.add(r.id);
    });

    for (let i = 1; i <= 6; i++) {
      await appendFile(p.main, lines(rec.req(`r${i}`, T(i))));
      await sleep(15);
    }

    await vi.waitFor(() => expect(seen.size).toBe(6), { timeout: 5000 });
    expect(patches).toBeLessThanOrEqual(2);
  });

  it('rebuilds the session when its transcript is replaced via rename', async () => {
    const p = await session('a', rec.req('r1', T(1)), rec.req('r2', T(2)));
    const s = await startStore();
    await s.getSnapshot(p.id);
    const resets: SessionSnapshot[] = [];
    s.onPatch(
      p.id,
      () => {},
      (snap) => resets.push(snap),
    );

    // rename is atomic: the watcher sees either the old file or the whole new one.
    await writeFile(`${p.main}.tmp`, lines(rec.req('r9', T(9))));
    await rename(`${p.main}.tmp`, p.main);

    await vi.waitFor(() => expect(resets).toHaveLength(1), { timeout: 5000 });
    expect(ids(resets[0]?.requests ?? [])).toEqual(['r9']);
    expect(ids((await s.getSnapshot(p.id))?.requests ?? [])).toEqual(['r9']);
    expect(fake.parsersFor('a')).toHaveLength(2);
  });

  it('rebuilds the session when its transcript is truncated, then patches in the rewrite', async () => {
    const p = await session('a', rec.req('r1', T(1)), rec.req('r2', T(2)));
    const s = await startStore();
    await s.getSnapshot(p.id);
    const resets: SessionSnapshot[] = [];
    const patches: SessionPatch[] = [];
    s.onPatch(
      p.id,
      (x) => patches.push(x),
      (snap) => resets.push(snap),
    );

    // Two separate writes: the store may (and here, must) observe the empty file in between.
    await truncate(p.main, 0);
    await vi.waitFor(() => expect(resets).toHaveLength(1), { timeout: 5000 });
    expect(resets[0]?.requests).toEqual([]);

    await appendFile(p.main, lines(rec.req('r9', T(9))));
    await vi.waitFor(() => expect(patches.flatMap((x) => ids(x.requests))).toContain('r9'), {
      timeout: 5000,
    });
    expect(resets).toHaveLength(1);
    expect(ids((await s.getSnapshot(p.id))?.requests ?? [])).toEqual(['r9']);
    expect(fake.parsersFor('a')).toHaveLength(2);
  });

  it('picks up a workflow run that starts after the session was opened within ~1 s', async () => {
    const p = await session('a', rec.req('r1', T(1)));
    const s = await startStore({ pollMs: 1000, liveMs: 1000 });
    await s.getSnapshot(p.id);
    const patches: SessionPatch[] = [];
    s.onPatch(p.id, (x) => patches.push(x));

    await put(p.wfAgent('wf_9', 'w9'), lines(rec.req('r9', T(9))));

    await vi.waitFor(() => expect(patches.flatMap((x) => ids(x.requests))).toContain('r9'), {
      timeout: 5000,
      interval: 20,
    });
    const snap = (await s.getSnapshot(p.id)) as SessionSnapshot;
    expect(snap.agents.find((a) => a.id === 'w9')?.workflowRunId).toBe('wf_9');
    expect(checkSnapshot(snap)).toEqual([]);
  });

  it('evicts the least recently used session beyond maxOpen', async () => {
    const a = await session('a', rec.req('ra', T(1)));
    const b = await session('b', rec.req('rb', T(2)));
    const c = await session('c', rec.req('rc', T(3)));
    const s = await startStore({ maxOpen: 2 });

    await s.getSnapshot(a.id);
    await s.getSnapshot(b.id);
    await s.getSnapshot(c.id); // evicts a
    await s.getSnapshot(a.id); // re-opens a, evicts b
    await s.getSnapshot(c.id); // still open

    expect(fake.parsersFor('a')).toHaveLength(2);
    expect(fake.parsersFor('b')).toHaveLength(1);
    expect(fake.parsersFor('c')).toHaveLength(1);
    // The re-opened session still has the right data.
    expect(ids((await s.getSnapshot(a.id))?.requests ?? [])).toEqual(['ra']);
  });

  it('never evicts busy or waiting sessions, or sessions with subscribers', async () => {
    const a = await session('a', rec.req('ra', T(1)));
    const b = await session('b', rec.req('rb', T(2)));
    const c = await session('c', rec.req('rc', T(3)));
    const d = await session('d', rec.req('rd', T(4)));
    const w = await session('w', rec.req('rw', T(5)));
    await setLive({ a: 'busy', w: 'waiting' });
    const s = await startStore({ maxOpen: 1 });

    await s.getSnapshot(a.id);
    await s.getSnapshot(w.id);
    await s.getSnapshot(b.id);
    s.onPatch(b.id, () => {});
    await s.getSnapshot(c.id);
    await s.getSnapshot(d.id); // only c is evictable
    await s.getSnapshot(a.id);
    await s.getSnapshot(w.id);
    await s.getSnapshot(b.id);
    await s.getSnapshot(c.id);

    expect(fake.parsersFor('a')).toHaveLength(1);
    expect(fake.parsersFor('w')).toHaveLength(1);
    expect(fake.parsersFor('b')).toHaveLength(1);
    expect(fake.parsersFor('c')).toHaveLength(2);
  });

  it('releases a session for eviction once its last subscriber leaves', async () => {
    const a = await session('a', rec.req('ra', T(1)));
    const b = await session('b', rec.req('rb', T(2)));
    const s = await startStore({ maxOpen: 1 });

    await s.getSnapshot(a.id);
    const off1 = s.onPatch(a.id, () => {});
    const off2 = s.onPatch(a.id, () => {});
    off1();
    off2();
    await s.getSnapshot(b.id); // a has no subscribers left → evicted
    await s.getSnapshot(a.id);

    expect(fake.parsersFor('a')).toHaveLength(2);
  });

  it('stops calling session listeners after they unsubscribe', async () => {
    await session('a', rec.req('ra', T(1)));
    const s = await startStore();
    const calls: SessionSummary[][] = [];
    const off = s.onSessions((x) => calls.push(x));

    await setLive({ a: 'busy' });
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 5000 });
    off();
    const before = calls.length;
    await setLive({ a: 'idle' });
    await sleep(250);
    expect(calls.length).toBe(before);
  });

  it('pushes live status changes to the list and to the open parser', async () => {
    const p = await session('a', rec.req('ra', T(1)));
    const s = await startStore();
    await s.getSnapshot(p.id);
    const lists: SessionSummary[][] = [];
    const patches: SessionPatch[] = [];
    s.onSessions((x) => lists.push(x));
    s.onPatch(p.id, (x) => patches.push(x));
    expect(s.listSessions()[0]?.live).toBe('closed');

    await setLive({ a: 'busy' });

    await vi.waitFor(() => expect(lists.at(-1)?.[0]?.live).toBe('busy'), { timeout: 5000 });
    await vi.waitFor(() => expect(patches.at(-1)?.session.live).toBe('busy'), { timeout: 5000 });
    expect(fake.parsersFor('a')[0]?.live).toBe('busy');
  });

  it('drops an activity worked out for a live state the poll has since replaced', async () => {
    const p = await session('a', rec.req('ra', T(1)));
    await setLive({ a: 'busy' });
    const s = await startStore({ patchMs: 60_000 });
    await vi.waitFor(() => expect(s.listSessions()[0]?.activity?.kind).toBe('thinking'), {
      timeout: 5000,
    });
    // A patch goes out now, so the parser's next summary waits a whole patch gap.
    await appendFile(p.main, lines(rec.req('rb', T(2))));
    await vi.waitFor(() => expect(s.listSessions()[0]?.counts?.requests).toBe(2), {
      timeout: 5000,
    });

    await setLive({ a: 'closed' });

    await vi.waitFor(() => expect(s.listSessions()[0]?.live).toBe('closed'), { timeout: 5000 });
    expect(s.listSessions()[0]).not.toHaveProperty('activity');
  });

  it('tells a session that opens the live state that changed while it loaded', async () => {
    const p = await session('a', rec.req('ra', T(1)));
    const s = await startStore();
    let release = () => {};
    fake.listFilesGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opening = s.getSnapshot(p.id);
    await setLive({ a: 'idle' });
    await vi.waitFor(() => expect(s.listSessions()[0]?.live).toBe('idle'), { timeout: 5000 });
    fake.listFilesGate = null;
    release();
    await opening;
    expect(fake.parsersFor('a').at(-1)?.live).toBe('idle');
  });

  it('gives an idle session that is not open its idle spell since the last write', async () => {
    await session('a', rec.req('ra', T(4)));
    await setLive({ a: 'idle' });
    const s = await startStore();
    const listed = s.listSessions()[0];
    expect(fake.parsersFor('a')).toHaveLength(0);
    expect(listed?.activity).toEqual({
      kind: 'idle',
      tool: null,
      target: null,
      agentId: 'main',
      since: listed?.updatedAt,
    });
  });

  it('discovers sessions created after start', async () => {
    await session('a', rec.req('ra', T(1)));
    const s = await startStore();
    const lists: SessionSummary[][] = [];
    s.onSessions((x) => lists.push(x));

    await session('b', rec.req('rb', T(2)));

    await vi.waitFor(() => expect(lists.at(-1)?.map((x) => x.nativeId)).toEqual(['b', 'a']), {
      timeout: 5000,
    });
  });

  it('folds session-list changes during a burst into at most two events, the last one current', async () => {
    // Pacing proven in coalescer.test.ts; a wide window keeps this independent of load.
    const p = await session('a', rec.req('r0', T(0)));
    const s = await startStore({ sessionsMs: 3000, patchMs: 10 });
    await s.getSnapshot(p.id);
    const lists: SessionSummary[][] = [];
    s.onSessions((x) => lists.push(x));

    for (let i = 1; i <= 5; i++) {
      await appendFile(p.main, lines(rec.req(`r${i}`, T(i))));
      await sleep(30);
    }

    await vi.waitFor(() => expect(lists.at(-1)?.[0]?.counts?.requests).toBe(6), {
      timeout: 5000,
    });
    expect(lists.length).toBeLessThanOrEqual(2);
  });

  it('reads a large transcript in chunks and logs how long the open took', async () => {
    const records = Array.from({ length: 2000 }, (_, i) => rec.req(`r${i}`, T(1)));
    const p = await session('a', ...records);
    const logs: string[] = [];
    const s = await startStore({ chunkBytes: 16 * 1024, log: (m) => logs.push(m) });

    const snap = (await s.getSnapshot(p.id)) as SessionSnapshot;

    expect(snap.requests).toHaveLength(2000);
    const mainIngests = fake.parsersFor('a')[0]?.ingested.filter((r) => r === 'main') ?? [];
    expect(mainIngests.length).toBeGreaterThan(4);
    expect(logs.some((m) => m.includes(p.id) && /\d+ ms/.test(m))).toBe(true);
  });

  it('delivers nothing after stop', async () => {
    const p = await session('a', rec.req('r0', T(0)));
    const s = await startStore();
    await s.getSnapshot(p.id);
    const patches: SessionPatch[] = [];
    s.onPatch(p.id, (x) => patches.push(x));

    await s.stop();
    await appendFile(p.main, lines(rec.req('r1', T(1))));
    await sleep(250);

    expect(patches).toEqual([]);
  });
});

describe('SessionStore signs of trouble', () => {
  const npmTest = (id: string) => rec.tool(id, 'ra', 'Bash', { command: 'npm test -- --run' });

  it('sends a running session’s strongest sign in its listed and patched summary', async () => {
    const p = await session('a', rec.req('ra', T(1)), npmTest('t1'), npmTest('t2'));
    await setLive({ a: 'busy' });
    const s = await startStore();
    await vi.waitFor(() => expect(s.listSessions()[0]?.trouble).toBeNull(), { timeout: 5000 });
    const patches: SessionPatch[] = [];
    s.onPatch(p.id, (x) => patches.push(x));

    await appendFile(p.main, lines(npmTest('t3')));

    const sign = {
      kind: 'repeat',
      // What a row may show of it: the command's summary, never its line.
      params: { x: 'npm test', n: 3 },
      at: { kind: 'tool', agentId: 'main', requestId: 'ra', toolCallId: 't3' },
      since: T(1),
    };
    await vi.waitFor(() => expect(s.listSessions()[0]?.trouble).toEqual(sign), { timeout: 5000 });
    // Patches carry it too, so a client's list keeps it.
    await appendFile(p.main, lines(rec.title('Still looping')));
    await vi.waitFor(() => expect(patches.at(-1)?.session.title).toBe('Still looping'), {
      timeout: 5000,
    });
    expect(patches.at(-1)?.session.trouble).toEqual(sign);
    expect((await s.getSnapshot(p.id))?.session.trouble).toEqual(sign);
  });

  it('carries none for a session that is not running, open or not', async () => {
    const p = await session('a', rec.req('ra', T(1)), npmTest('t1'), npmTest('t2'), npmTest('t3'));
    const s = await startStore();
    await s.getSnapshot(p.id);
    expect(s.listSessions()[0]).not.toHaveProperty('trouble');
    expect((await s.getSnapshot(p.id))?.session).not.toHaveProperty('trouble');
  });

  it('reads them again as time passes: a wait becomes a sign with nothing written', async () => {
    let now = Date.parse(T(1)) + 5 * 60_000;
    await session('a', rec.req('ra', T(1)));
    await setLive({ a: 'waiting' });
    const s = await startStore({ now: () => now });
    await vi.waitFor(() => expect(s.listSessions()[0]?.trouble).toBeNull(), { timeout: 5000 });

    now += 6 * 60_000;

    await vi.waitFor(() => expect(s.listSessions()[0]?.trouble?.kind).toBe('waiting'), {
      timeout: 5000,
    });
    expect(s.listSessions()[0]?.trouble?.since).toBe(T(1));
  });

  it('drops a sign worked out for a live state the poll has since replaced', () => {
    const sign = { kind: 'waiting' as const, params: {}, at: null, since: T(1) };
    const waiting: SessionSummary = {
      ...createDemoSessions()[0],
      live: 'waiting',
      trouble: sign,
    } as SessionSummary;
    expect(listedSummary(waiting, 'waiting').trouble).toEqual(sign);
    expect(listedSummary(waiting, 'busy')).not.toHaveProperty('trouble');
    expect(listedSummary(waiting, 'closed')).not.toHaveProperty('trouble');
  });
});

describe('SessionStore token rate', () => {
  // The store's clock is the test's, moved only by the test. The wall clock can turn the minute
  // between two reads, or step back while a session settles (WSL steps it back ~0.8 s every half
  // minute), and then no fixed wait is long enough.
  const BASE = Date.parse('2026-10-24T10:00:00.000Z');
  let clock = BASE;
  // Live polls finished: a session's settling ends at the first one past its deadline.
  let polls = 0;
  beforeEach(() => {
    clock = BASE;
    polls = 0;
    const liveStatus = fake.liveStatus.bind(fake);
    fake.liveStatus = () =>
      liveStatus().finally(() => {
        polls++;
      });
  });
  const startRate = (opts: Partial<SessionStoreOptions> = {}) =>
    startStore({ rateMs: 20, now: () => clock, ...opts });

  /** Waits for a live poll to finish, from now: it reads the clock as it ends. */
  async function polled() {
    const before = polls;
    await vi.waitFor(() => expect(polls).toBeGreaterThan(before), { timeout: 5000 });
  }

  /**
   * Ends the settling of a session that has loaded (until its load's clock plus `liveMs`): moves
   * the clock past it, and a live poll releases it. Its growth counts from then on.
   */
  async function settled() {
    clock += 1000;
    await polled();
  }

  /** The session's usage as the rate has seen it: the store's summary, a flush behind a snapshot. */
  const usageOf = (s: SessionStore, nativeId: string) =>
    s.listSessions().find((x) => x.nativeId === nativeId)?.usage ?? null;

  it('counts an open session’s growth after its first sighting, for its agent kind', async () => {
    const p = await session('a', rec.req('ra', T(1), 10));
    const s = await startRate();
    await s.getSnapshot(p.id);
    // Everything it spent before is a baseline, not a spike.
    expect(hourTotal(s.getRate())).toBe(0);
    await settled();
    const pushed: TokenRate[] = [];
    s.onRate((r) => pushed.push(r));

    // One more request: 1 input + 7 output.
    await appendFile(p.main, lines(rec.req('rb', T(2), 7)));
    await vi.waitFor(() => expect(hourTotal(s.getRate())).toBe(8), { timeout: 5000 });
    const rate = s.getRate();
    expect(rateSeries(rate, { agent: fake.kind }).at(-1)).toBe(8);
    expect(rateSeries(rate, { kind: 'output' }).at(-1)).toBe(7);
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(hourTotal(pushed.at(-1) as TokenRate)).toBe(8);
  });

  // F S1: a paused session's rate comes down before the minute turns, pushed each 15 s step.
  it('lets the rate decay while spending pauses, and pushes it before the minute turns', async () => {
    const MIN = 60_000;
    const p = await session('a', rec.req('ra', T(1), 10));
    const s = await startRate({ rateTickMs: 40 });
    await s.getSnapshot(p.id);
    await settled();
    const pushed: TokenRate[] = [];
    s.onRate((r) => pushed.push(r));
    // Four minutes at 1M a minute, then the first 10 s of the fifth, then nothing.
    for (let m = 1; m <= 5; m++) {
      clock = BASE + m * MIN + (m < 5 ? 30_000 : 10_000);
      await appendFile(p.main, lines(rec.req(`r${m}`, T(1 + m), m < 5 ? 999_999 : 166_666)));
      const total = Math.min(m, 4) * 1_000_000 + (m === 5 ? 166_667 : 0);
      await vi.waitFor(() => expect(hourTotal(s.getRate())).toBe(total), { timeout: 5000 });
    }
    // At :59, with no new spend, the rate pushed is the 5-minute average as of :59.
    clock = BASE + 5 * MIN + 59_000;
    await vi.waitFor(() => expect(Date.parse(pushed.at(-1)?.at ?? '')).toBe(clock), {
      timeout: 5000,
    });
    const shown = ratePerMinute(pushed.at(-1) as TokenRate);
    expect(shown).toBeCloseTo(4_166_667 / (4 + 59 / 60), 0);
    expect(Math.round(shown / 10_000) / 100).toBe(0.84);
  });

  it('takes a session that vanishes and comes back as a baseline again', async () => {
    const p = await session('a', rec.req('ra', T(1), 10));
    const s = await startRate();
    await s.getSnapshot(p.id);
    await settled();
    await appendFile(p.main, lines(rec.req('rb', T(2), 7)));
    await vi.waitFor(() => expect(hourTotal(s.getRate())).toBe(8), { timeout: 5000 });

    // Gone from disk for two discoveries: dropped, and forgotten.
    await rm(p.main);
    await vi.waitFor(() => expect(s.listSessions()).toHaveLength(0), { timeout: 5000 });
    // Back with far more in it: reopening it is a baseline, not 1,000 tokens at once.
    await put(
      p.main,
      lines(rec.req('ra', T(1), 10), rec.req('rb', T(2), 7), rec.req('rc', T(3), 990)),
    );
    await vi.waitFor(() => expect(s.listSessions()).toHaveLength(1), { timeout: 5000 });
    await s.getSnapshot(p.id);
    await settled();
    expect(hourTotal(s.getRate())).toBe(8);
    await appendFile(p.main, lines(rec.req('rd', T(4), 4)));
    await vi.waitFor(() => expect(hourTotal(s.getRate())).toBe(13), { timeout: 5000 });
  });

  it('takes growth while a session settles after opening as history', async () => {
    const p = await session('a', rec.req('ra', T(1), 10));
    const s = await startRate({ liveMs: 400 });
    await s.getSnapshot(p.id);
    // Still settling, a live poll later (the clock has not reached its end): written as the
    // session loaded, not counted as spend.
    await polled();
    await appendFile(p.main, lines(rec.req('rb', T(2), 50)));
    await vi.waitFor(() => expect(usageOf(s, 'a')?.output).toBe(60), { timeout: 5000 });
    await settled();
    expect(hourTotal(s.getRate())).toBe(0);
    await appendFile(p.main, lines(rec.req('rc', T(3), 4)));
    await vi.waitFor(() => expect(hourTotal(s.getRate())).toBe(5), { timeout: 3000 });
  });

  it('counts nothing of an old session with sub-agents when it opens', async () => {
    const p = await session('a', rec.req('ra', T(1), 10));
    await put(p.subagent('s1'), lines(rec.req('rs1', T(1), 50_000), rec.req('rs2', T(2), 70_000)));
    const s = await startRate();
    await s.getSnapshot(p.id);
    await settled();
    expect(hourTotal(s.getRate())).toBe(0);
  });

  it('takes a sub-agent transcript classified after the open as history, then counts its growth', async () => {
    const p = await session('a', rec.req('ra', T(1), 10));
    const s = await startRate();
    await s.getSnapshot(p.id);
    await settled();
    // A sub-agent file that turns up with an hour of work in it: read now, spent before. Seen by
    // the rate before anything more is written, or the two would be read as one.
    await put(p.subagent('s1'), lines(rec.req('rs1', T(1), 90_000)));
    await vi.waitFor(() => expect(usageOf(s, 'a')?.output).toBe(90_010), { timeout: 5000 });
    expect(hourTotal(s.getRate())).toBe(0);
    // What it writes from then on is spend.
    await appendFile(p.subagent('s1'), lines(rec.req('rs2', T(2), 6)));
    await vi.waitFor(() => expect(hourTotal(s.getRate())).toBe(7), { timeout: 5000 });
  });

  it('counts a running session right after it settles, and says which running ones it counts', async () => {
    await session('a', rec.req('ra', T(1), 10));
    const b = await session('b', rec.req('rb', T(2), 10));
    await setLive({ a: 'busy', b: 'busy' });
    // Room for one open session: the other running one cannot be counted.
    const s = await startRate({ maxOpen: 1 });
    // The newer one opens in the background; once loaded, it settles.
    await vi.waitFor(() => expect(usageOf(s, 'b')).not.toBeNull(), { timeout: 5000 });
    await settled();
    await vi.waitFor(() => expect(s.getRate().coverage.counted).toBe(1), { timeout: 5000 });
    expect(s.getRate().coverage).toEqual({
      running: 2,
      counted: 1,
      agents: { [fake.kind]: { running: 2, counted: 1 } },
    });
    // The newer one was opened; its growth counts at once.
    await appendFile(b.main, lines(rec.req('rc', T(3), 4)));
    await vi.waitFor(() => expect(hourTotal(s.getRate())).toBe(5), { timeout: 5000 });
  });

  it('says nothing about sessions it has not opened, and stops cleanly', async () => {
    await session('a', rec.req('ra', T(1), 10));
    const s = await startRate();
    expect(s.getRate().agents).toEqual({});
    await s.stop();
    store = undefined;
  });
});

describe('SessionStore quota', () => {
  it('reports no quota when no adapter has any', async () => {
    const s = await startStore();
    expect(s.listQuotas()).toEqual([]);
  });

  it('serves adapter quotas and pushes changes', async () => {
    const q = createDemoQuota(new Date('2026-10-23T02:00:00.000Z'));
    await writeFile(join(root, 'quota.json'), JSON.stringify(q));
    fake = createFakeAdapter(root, { quota: true });
    const s = await startStore({ quotaPollMs: 50 });
    await vi.waitFor(() => expect(s.listQuotas()).toEqual([q]), { timeout: 5000 });
    const seen: QuotaSnapshot[][] = [];
    s.onQuota((x) => seen.push(x));

    const aged = { ...q, stale: true };
    await writeFile(join(root, 'quota.json'), JSON.stringify(aged));

    await vi.waitFor(() => expect(seen.at(-1)).toEqual([aged]), { timeout: 5000 });
    expect(s.listQuotas()).toEqual([aged]);
  });

  it('starts without waiting for a provider that never answers, and serves the rest as they land', async () => {
    const q = createDemoQuota(new Date('2026-10-23T02:00:00.000Z'));
    // A usage fetch on a network that drops packets: its read never settles.
    const fetching = { id: 'xai-api', read: () => new Promise<QuotaSnapshot[]>(() => {}) };
    const cache = { id: 'cache', read: async () => [q] };
    const started = await Promise.race([
      startStore({ quotaSources: [fetching, cache] }).then(() => 'listening'),
      new Promise((r) => setTimeout(() => r('blocked'), 1000)),
    ]);
    expect(started).toBe('listening');
    const s = store as SessionStore;
    await vi.waitFor(() => expect(s.listQuotas()).toEqual([q]), { timeout: 5000 });
  });
});

describe('SessionStore removals', () => {
  it('passes removals through to subscribers, so clients converge on the snapshot', async () => {
    const p = await session('a', rec.req('r1', T(1)), rec.tool('tu1', 'r1'), rec.req('r2', T(2)));
    const s = await startStore();
    let client = (await s.getSnapshot(p.id)) as SessionSnapshot;
    const patches: SessionPatch[] = [];
    s.onPatch(p.id, (x) => {
      patches.push(x);
      client = applyPatch(client, x);
    });

    await appendFile(p.main, lines(rec.drop('r1')));

    await vi.waitFor(() => expect(patches.at(-1)?.removed?.requests).toEqual(['r1']), {
      timeout: 5000,
    });
    expect(patches.at(-1)?.removed?.toolCalls).toEqual(['tu1']);
    const server = (await s.getSnapshot(p.id)) as SessionSnapshot;
    expect(ids(server.requests)).toEqual(['r2']);
    expect(client).toEqual(server);
  });

  it('delivers a request added and dropped within one batch as removed only', async () => {
    const p = await session('a', rec.req('r1', T(1)));
    const s = await startStore({ patchMs: 1500 });
    let client = (await s.getSnapshot(p.id)) as SessionSnapshot;
    const patches: SessionPatch[] = [];
    s.onPatch(p.id, (x) => {
      patches.push(x);
      client = applyPatch(client, x);
    });
    // Spend the first flush so the next changes wait out a full batch window together.
    await appendFile(p.main, lines(rec.req('r2', T(2))));
    await vi.waitFor(() => expect(patches).toHaveLength(1), { timeout: 5000 });

    await appendFile(p.main, lines(rec.req('r3', T(3))));
    await sleep(60);
    await appendFile(p.main, lines(rec.drop('r3')));

    await vi.waitFor(() => expect(patches.at(-1)?.removed?.requests).toEqual(['r3']), {
      timeout: 5000,
    });
    expect(patches).toHaveLength(2);
    expect(ids(patches[1]?.requests ?? [])).not.toContain('r3');
    expect(client).toEqual(await s.getSnapshot(p.id));
  });
});

describe('SessionStore removal-only changes', () => {
  it('delivers a change set that carries nothing but a removal', async () => {
    const p = await session('a', rec.req('r1', T(1)), rec.req('r2', T(2)));
    const s = await startStore();
    await s.getSnapshot(p.id);
    const patches: SessionPatch[] = [];
    s.onPatch(p.id, (x) => patches.push(x));

    await appendFile(p.main, lines(rec.drop('r1', { removalOnly: true })));

    await vi.waitFor(() => expect(patches.at(-1)?.removed?.requests).toEqual(['r1']), {
      timeout: 5000,
    });
  });
});

describe('SessionStore with a misbehaving parser', () => {
  it('keeps polling live status when one parser throws', async () => {
    const bad = await session('bad', rec.req('rb', T(1)));
    const good = await session('good', rec.req('rg', T(2)));
    const createParser = fake.createParser;
    fake.createParser = (source) => {
      const parser = createParser(source);
      if (source.nativeId === 'bad')
        parser.setLive = () => {
          throw new Error('parser bug');
        };
      return parser;
    };
    const logs: string[] = [];
    const s = await startStore({ log: (m) => logs.push(m) });
    await s.getSnapshot(bad.id);
    await s.getSnapshot(good.id);
    const blamed = () => logs.filter((m) => m.includes(bad.id) && m.includes('parser bug')).length;
    const before = blamed();

    await setLive({ bad: 'busy', good: 'busy' });
    await vi.waitFor(() => expect(fake.parsersFor('good')[0]?.live).toBe('busy'), {
      timeout: 5000,
    });
    // The loop is still alive afterwards.
    await setLive({ good: 'idle' });
    await vi.waitFor(() => expect(fake.parsersFor('good')[0]?.live).toBe('idle'), {
      timeout: 5000,
    });
    // The live change was logged against the broken session, which is all that degrades.
    expect(blamed()).toBeGreaterThan(before);
  });
});

describe('SessionStore when discovery briefly misses a session', () => {
  it('keeps a session that is being opened, without leaving a second parser behind', async () => {
    const p = await session('a', rec.req('r1', T(1)));
    const s = await startStore({ discoverMs: 20 });
    let release: () => void = () => {};
    fake.listFilesGate = new Promise((r) => {
      release = r;
    });
    const opening = s.getSnapshot(p.id);
    fake.hideFor('a', 3);
    const calls = fake.discoverCalls;
    await vi.waitFor(() => expect(fake.discoverCalls).toBeGreaterThanOrEqual(calls + 3), {
      timeout: 5000,
    });
    fake.listFilesGate = null;
    release();
    expect(ids((await opening)?.requests ?? [])).toEqual(['r1']);

    const patches: SessionPatch[] = [];
    s.onPatch(p.id, (x) => patches.push(x));
    await appendFile(p.main, lines(rec.req('r2', T(2))));
    await vi.waitFor(() => expect(patches.flatMap((x) => ids(x.requests))).toContain('r2'), {
      timeout: 5000,
    });
    await sleep(200);
    expect(patches.flatMap((x) => ids(x.requests)).filter((id) => id === 'r2')).toHaveLength(1);
    expect(fake.parsersFor('a')).toHaveLength(1);
    expect(s.listSessions().map((x) => x.nativeId)).toEqual(['a']);

    await s.stop();
    const parser = fake.parsersFor('a')[0];
    const ingested = parser?.ingested.length;
    await appendFile(p.main, lines(rec.req('r3', T(3))));
    await sleep(200);
    expect(parser?.ingested.length).toBe(ingested);
  });

  it('keeps a session through one missed discovery and drops it after two', async () => {
    const p = await session('a', rec.req('r1', T(1)));
    await session('b', rec.req('r2', T(2)));
    const s = await startStore({ discoverMs: 20 });
    await s.getSnapshot(p.id);

    fake.hideFor('a', 1);
    const calls = fake.discoverCalls;
    await vi.waitFor(() => expect(fake.discoverCalls).toBeGreaterThanOrEqual(calls + 3), {
      timeout: 5000,
    });
    expect(s.listSessions().map((x) => x.nativeId)).toContain('a');
    await s.getSnapshot(p.id);
    expect(fake.parsersFor('a')).toHaveLength(1);

    fake.hideFor('a', 1_000);
    await vi.waitFor(() => expect(s.listSessions().map((x) => x.nativeId)).toEqual(['b']), {
      timeout: 5000,
    });
  });
});

describe('SessionStore auto-opening active sessions', () => {
  const usageOf = (s: SessionStore, nativeId: string) =>
    s.listSessions().find((x) => x.nativeId === nativeId)?.usage ?? null;

  it('opens busy and waiting sessions in the background, so the list shows their usage', async () => {
    await session('b', rec.req('rb', T(1), 7));
    await session('w', rec.req('rw', T(2), 9));
    await session('c', rec.req('rc', T(3)));
    await setLive({ b: 'busy', w: 'waiting' });
    const s = await startStore();

    await vi.waitFor(
      () => {
        expect(usageOf(s, 'b')?.output).toBe(7);
        expect(usageOf(s, 'w')?.output).toBe(9);
      },
      { timeout: 5000 },
    );
    expect(usageOf(s, 'c')).toBeNull();
    expect(fake.parsersFor('c')).toHaveLength(0);
  });

  it('auto-opens at most maxOpen of them, the most recently updated first', async () => {
    await session('old', rec.req('r1', T(1)));
    await session('newest', rec.req('r3', T(3)));
    await session('middle', rec.req('r2', T(2)));
    await setLive({ old: 'busy', newest: 'busy', middle: 'waiting' });
    const s = await startStore({ maxOpen: 2 });

    await vi.waitFor(
      () => {
        expect(fake.parsersFor('newest')).toHaveLength(1);
        expect(fake.parsersFor('middle')).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    await sleep(200);
    expect(fake.parsersFor('old')).toHaveLength(0);
    expect(usageOf(s, 'old')).toBeNull();
  });

  it('auto-opens a session when it turns busy', async () => {
    await session('a', rec.req('ra', T(1), 4));
    // Discovery effectively off: the live poll alone must notice.
    const s = await startStore({ discoverMs: 60_000 });
    await sleep(100);
    expect(fake.parsersFor('a')).toHaveLength(0);

    await setLive({ a: 'busy' });

    await vi.waitFor(() => expect(usageOf(s, 'a')?.output).toBe(4), { timeout: 5000 });
  });

  it('never makes start or the session list wait for an auto-open', async () => {
    await session('a', rec.req('ra', T(1)));
    await setLive({ a: 'busy' });
    let release: () => void = () => {};
    fake.listFilesGate = new Promise((r) => {
      release = r;
    });

    const s = await startStore();
    expect(s.listSessions().map((x) => x.nativeId)).toEqual(['a']);
    await vi.waitFor(() => expect(fake.parsersFor('a')).toHaveLength(1), { timeout: 5000 });
    expect(usageOf(s, 'a')).toBeNull(); // still opening

    fake.listFilesGate = null;
    release();
    await vi.waitFor(() => expect(usageOf(s, 'a')).not.toBeNull(), { timeout: 5000 });
  });
});

describe('SessionStore.expectSession', () => {
  it('answers at once for a session it already knows', async () => {
    const p = await session('a', rec.req('ra', T(1)));
    const s = await startStore({ discoverMs: 60_000 });
    expect(await s.expectSession(p.id)).toBe(true);
  });

  it('finds a session that appears later without waiting for the discovery interval', async () => {
    // The regular discovery is effectively off; only expectSession's quick polling can find it.
    const s = await startStore({ discoverMs: 60_000 });
    const found = s.expectSession(fakePaths(root, 'proj', 'late').id);
    await sleep(150);
    await session('late', rec.req('rl', T(1)));

    expect(await found).toBe(true);
    expect(s.listSessions().map((x) => x.nativeId)).toEqual(['late']);
    expect((await s.getSnapshot(fakePaths(root, 'proj', 'late').id))?.requests).toHaveLength(1);
  });

  it('gives up after its timeout', async () => {
    const s = await startStore({ discoverMs: 60_000 });
    expect(await s.expectSession('fake:never', 300)).toBe(false);
  });

  it('stops polling once nobody is waiting', async () => {
    const s = await startStore({ discoverMs: 60_000 });
    await s.expectSession('fake:never', 300);
    const calls = fake.discoverCalls;
    await sleep(600);
    expect(fake.discoverCalls).toBe(calls);
  });

  it('answers every waiter, and false to all of them on stop', async () => {
    const s = await startStore({ discoverMs: 60_000 });
    const id = fakePaths(root, 'proj', 'x').id;
    const waits = [s.expectSession(id), s.expectSession(id), s.expectSession('fake:other')];
    await s.stop();
    expect(await Promise.all(waits)).toEqual([false, false, false]);
  });
});

describe('SessionStore with busy neighbours', () => {
  it('looks at a sibling session’s file once, not on every write to it', async () => {
    const a = await session('a', rec.req('ra', T(1)));
    const b = await session('b', rec.req('rb', T(2)));
    const classify = fake.classify;
    const watchDirs = fake.watchDirs;
    let classifiedB = 0;
    let dirLookups = 0;
    fake.classify = (source, path) => {
      if (path === b.main) classifiedB++;
      return classify(source, path);
    };
    fake.watchDirs = (source) => {
      dirLookups++;
      return watchDirs(source);
    };
    // No live ticks: they refresh watch dirs on their own schedule.
    const s = await startStore({ liveMs: 60_000, discoverMs: 60_000 });
    await s.getSnapshot(a.id);

    // The first write is news (and may come with platform noise, e.g. FSEvents naming the
    // watched dir itself); after that, writes to the neighbour cost nothing.
    await appendFile(b.main, lines(rec.req('rb0', T(3))));
    await sleep(300);
    const lookups = dirLookups;
    for (let i = 1; i < 5; i++) {
      await appendFile(b.main, lines(rec.req(`rb${i}`, T(3 + i))));
      await sleep(120);
    }
    await sleep(200);

    expect(classifiedB).toBe(1);
    expect(dirLookups).toBe(lookups);
  });

  it('asks again about a file classify could not place yet, so a new sub-agent is not lost', async () => {
    const p = await session('a', rec.req('r1', T(1)));
    // The sub-agents dir exists before the session opens, so it is watched from the start.
    await put(p.subagent('s0'), lines(rec.req('r0', T(1))));
    const classify = fake.classify;
    let asked = 0;
    fake.classify = (source, path) => {
      if (path !== p.subagent('s1')) return classify(source, path);
      // Like a Codex rollout whose header is still being written when the watcher first sees it.
      return asked++ === 0 ? 'later' : classify(source, path);
    };
    const s = await startStore({ liveMs: 60_000, discoverMs: 60_000 });
    expect(ids((await s.getSnapshot(p.id))?.requests ?? [])).toEqual(['r0', 'r1']);

    await put(p.subagent('s1'), lines(rec.req('r2', T(2))));
    await vi.waitFor(() => expect(asked).toBeGreaterThanOrEqual(1), { timeout: 3000 });
    await appendFile(p.subagent('s1'), lines(rec.req('r3', T(3))));

    await vi.waitFor(
      async () =>
        expect(ids((await s.getSnapshot(p.id))?.requests ?? [])).toEqual(['r0', 'r1', 'r2', 'r3']),
      { timeout: 3000 },
    );
  });
});

describe('SessionStore with several adapters', () => {
  async function other() {
    const otherRoot = join(root, 'other-agent');
    const adapter = createFakeAdapter(otherRoot, { kind: 'other' });
    const put2 = async (nativeId: string, ...records: string[]) => {
      const p = fakePaths(otherRoot, 'proj', nativeId, 'other');
      await put(p.main, lines(...records));
      return p;
    };
    const setLive2 = (states: Record<string, string>) =>
      writeFile(join(otherRoot, 'live.json'), JSON.stringify(states));
    return { adapter, put: put2, setLive: setLive2 };
  }

  it('merges every adapter’s sessions into one list, ordered as usual', async () => {
    const o = await other();
    await session('a1', rec.req('ra', T(1)));
    await o.put('b1', rec.req('rb1', T(5)));
    const b2 = await o.put('b2', rec.req('rb2', T(2)));
    await setLive({ a1: 'busy' });
    const s = await startStore({ adapters: [fake, o.adapter] });

    expect(s.listSessions().map((x) => x.id)).toEqual(['fake:a1', 'other:b1', 'other:b2']);
    expect(ids((await s.getSnapshot(b2.id))?.requests ?? [])).toEqual(['rb2']);
    expect(o.adapter.parsersFor('b2')).toHaveLength(1);
    expect(fake.parsersFor('b2')).toHaveLength(0);
  });

  it('keeps serving one adapter when another fails', async () => {
    const o = await other();
    const a = await session('a1', rec.req('ra', T(1)));
    await o.put('b1', rec.req('rb1', T(5)));
    const logs: string[] = [];
    const s = await startStore({ adapters: [o.adapter, fake], log: (m) => logs.push(m) });
    expect(s.listSessions().map((x) => x.id)).toEqual(['other:b1', 'fake:a1']);

    // From now on the other agent's discovery and live status both throw.
    o.adapter.discover = async () => {
      throw new Error('other agent broke');
    };
    o.adapter.liveStatus = async () => {
      throw new Error('other agent broke');
    };
    await session('a2', rec.req('ra2', T(6)));
    await setLive({ a1: 'busy' });

    await vi.waitFor(
      () => {
        const list = s.listSessions();
        expect(list.map((x) => x.id)).toEqual(['fake:a1', 'fake:a2', 'other:b1']);
        expect(list[0]?.live).toBe('busy');
      },
      { timeout: 5000 },
    );
    expect(ids((await s.getSnapshot(a.id))?.requests ?? [])).toEqual(['ra']);
    expect(logs.some((m) => m.includes('other agent broke'))).toBe(true);
  });
});

describe('SessionStore with encoded (archived) files', () => {
  const archive = (text: string) => encodeFake(text);

  it('reads an archived transcript whole through the adapter, last line included', async () => {
    const p = fakePaths(root, 'proj', 'a');
    // No newline after the last record.
    await put(
      `${p.main}.zst`,
      archive([rec.req('r1', T(1), 3), rec.req('r2', T(2), 4)].join('\n')),
    );
    const s = await startStore();

    const snap = (await s.getSnapshot(p.id)) as SessionSnapshot;
    expect(ids(snap.requests)).toEqual(['r1', 'r2']);
    expect(snap.session.usage?.output).toBe(7);
    expect(checkSnapshot(snap)).toEqual([]);
  });

  it('skips an archive the adapter cannot read, keeps the rest, and logs it', async () => {
    const p = await session('a', rec.req('r1', T(1)));
    const sub = join(p.sessionDir, 'subagents', 'agent-s1.jsonl.zst');
    await put(sub, archive(lines(rec.req('r2', T(2)))));
    fake.failReads.add(sub);
    const logs: string[] = [];
    const s = await startStore({ log: (m) => logs.push(m) });

    expect(ids((await s.getSnapshot(p.id))?.requests ?? [])).toEqual(['r1']);
    expect(logs.some((m) => m.includes(sub) && m.includes('corrupt archive'))).toBe(true);
  });

  it('skips archives when the adapter cannot decode them at all', async () => {
    fake = createFakeAdapter(root, { readFile: false });
    const p = await session('a', rec.req('r1', T(1)));
    const sub = join(p.sessionDir, 'subagents', 'agent-s1.jsonl.zst');
    await put(sub, archive(lines(rec.req('r2', T(2)))));
    const logs: string[] = [];
    const s = await startStore({ log: (m) => logs.push(m) });

    expect(ids((await s.getSnapshot(p.id))?.requests ?? [])).toEqual(['r1']);
    expect(logs.some((m) => m.includes(sub) && m.includes('readFile'))).toBe(true);
  });

  it('ignores reports about an archive it has already read', async () => {
    const p = fakePaths(root, 'proj', 'a');
    await put(`${p.main}.zst`, archive(lines(rec.req('r1', T(1)))));
    const s = await startStore();
    await s.getSnapshot(p.id);
    const patches: SessionPatch[] = [];
    s.onPatch(p.id, (x) => patches.push(x));

    await appendFile(`${p.main}.zst`, 'more bytes');
    await sleep(300);

    expect(patches).toEqual([]);
    expect(fake.parsersFor('a')).toHaveLength(1);
  });

  it('drops what a deleted file contributed', async () => {
    const p = await session('a', rec.req('r1', T(1)));
    await put(p.subagent('s1'), lines(rec.req('r2', T(2))));
    const s = await startStore();
    expect(ids((await s.getSnapshot(p.id))?.requests ?? [])).toEqual(['r1', 'r2']);

    await rm(p.subagent('s1'));

    await vi.waitFor(
      async () => expect(ids((await s.getSnapshot(p.id))?.requests ?? [])).toEqual(['r1']),
      { timeout: 3000 },
    );
  });

  it.each([
    ['the archive is written, then the live file removed', 'archive-first'],
    ['the live file is removed, then the archive written', 'remove-first'],
  ])('switches to the archive when %s, counting nothing twice', async (_name, order) => {
    const p = await session('a', rec.req('r1', T(1), 3), rec.req('r2', T(2), 4));
    const s = await startStore();
    const before = (await s.getSnapshot(p.id)) as SessionSnapshot;
    // Someone is watching, so the session stays open (and is rebuilt) across the switch.
    let client = before;
    s.onPatch(
      p.id,
      (x) => {
        client = applyPatch(client, x);
      },
      (snap) => {
        client = snap;
      },
    );
    const text = await readFile(p.main, 'utf8');

    if (order === 'archive-first') {
      await writeFile(`${p.main}.zst`, archive(text));
      await sleep(150);
      await rm(p.main);
    } else {
      await rm(p.main);
      await sleep(300);
      await writeFile(`${p.main}.zst`, archive(text));
    }

    await vi.waitFor(
      async () => {
        const after = (await s.getSnapshot(p.id)) as SessionSnapshot;
        const latest = fake.parsersFor('a').at(-1);
        expect(latest?.ingestedPaths).toEqual([`${p.main}.zst`]); // read once, from the archive
        expect(ids(after.requests)).toEqual(['r1', 'r2']);
        expect(client).toEqual(after);
        expect(after.session.usage).toEqual(before.session.usage);
        expect(after.session.counts).toEqual(before.session.counts);
      },
      { timeout: 3000 },
    );
    expect(existsSync(p.main)).toBe(false);
  });
});

describe('SessionStore with sources the adapter supplies (readJson)', () => {
  let db: FakeDbAdapter;
  const sid = `${FAKE_DB_AGENT}:a`;

  beforeEach(() => {
    db = createFakeDbAdapter(root);
  });

  /** Rewrites the fake database; `records` are toy record lines. */
  const writeDb = (rows: Record<string, { version: string; records: string[] }>) =>
    put(
      db.dbPath,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(rows).map(([id, r]) => [
            id,
            { version: r.version, records: r.records.map((l) => JSON.parse(l)) },
          ]),
        ),
      ),
    );
  let walWrites = 0;
  /** A write to the journal only, as a database writer makes between checkpoints. */
  const touchWal = () => writeFile(`${db.dbPath}-wal`, String(++walWrites));

  /** Opens session `a` with one subscriber; returns what the subscriber has seen. */
  async function watchA(s: SessionStore) {
    let client = (await s.getSnapshot(sid)) as SessionSnapshot;
    const patches: SessionPatch[] = [];
    s.onPatch(sid, (x) => {
      patches.push(x);
      client = applyPatch(client, x);
    });
    return { patches, client: () => client };
  }

  it('reads a session through the adapter instead of from disk', async () => {
    await writeDb({
      a: { version: 'v1', records: [rec.title('From the db'), rec.req('r1', T(1))] },
    });
    const s = await startStore({ adapters: [db] });

    const snap = (await s.getSnapshot(sid)) as SessionSnapshot;
    expect(ids(snap.requests)).toEqual(['r1']);
    expect(snap.session.title).toBe('From the db');
    expect(db.parsers[0]?.ingested).toEqual(['db-session']);
    expect(checkSnapshot(snap)).toEqual([]);
  });

  it('reads again when a path classify maps to the source changes, and patches the news in', async () => {
    await writeDb({ a: { version: 'v1', records: [rec.req('r1', T(1))] } });
    const s = await startStore({ adapters: [db] });
    const seen = await watchA(s);

    await writeDb({ a: { version: 'v2', records: [rec.req('r1', T(1)), rec.req('r2', T(2))] } });
    await touchWal();

    await vi.waitFor(() => expect(ids(seen.client().requests)).toEqual(['r1', 'r2']), {
      timeout: 5000,
    });
    expect(seen.client()).toEqual(await s.getSnapshot(sid));
    expect(db.parsers).toHaveLength(1);
  });

  it('feeds the parser nothing while the version stays the same', async () => {
    await writeDb({ a: { version: 'v1', records: [rec.req('r1', T(1))] } });
    const s = await startStore({ adapters: [db] });
    const seen = await watchA(s);
    const readsBefore = db.reads;

    // The journal moves (both paths report it) but the session's version does not.
    await touchWal();
    await vi.waitFor(() => expect(db.reads).toBeGreaterThan(readsBefore), { timeout: 5000 });
    await touchWal();
    await sleep(300);

    expect(db.parsers[0]?.ingested).toEqual(['db-session']);
    expect(seen.patches).toEqual([]);
  });

  it('keeps what it has while the adapter cannot read, logging once per failing streak', async () => {
    await writeDb({ a: { version: 'v1', records: [rec.req('r1', T(1))] } });
    const logs: string[] = [];
    const s = await startStore({ adapters: [db], log: (m) => logs.push(m) });
    const seen = await watchA(s);
    const failures = () => logs.filter((m) => m.includes('database is locked'));

    db.failWith = new Error('database is locked');
    const readsBefore = db.reads;
    await touchWal();
    await vi.waitFor(() => expect(db.reads).toBeGreaterThan(readsBefore), { timeout: 5000 });
    await touchWal();
    await vi.waitFor(() => expect(db.reads).toBeGreaterThan(readsBefore + 1), { timeout: 5000 });
    expect(failures()).toHaveLength(1);
    expect(failures()[0]).toContain(db.dbPath);
    expect(ids(seen.client().requests)).toEqual(['r1']);

    db.failWith = null;
    await writeDb({ a: { version: 'v2', records: [rec.req('r1', T(1)), rec.req('r2', T(2))] } });
    await touchWal();
    await vi.waitFor(() => expect(ids(seen.client().requests)).toEqual(['r1', 'r2']), {
      timeout: 5000,
    });

    // A new streak is logged again.
    db.failWith = new Error('database is locked');
    await touchWal();
    await vi.waitFor(() => expect(failures()).toHaveLength(2), { timeout: 5000 });
  });

  it('keeps what it has when the adapter has nothing to read', async () => {
    await writeDb({ a: { version: 'v1', records: [rec.req('r1', T(1))] } });
    const s = await startStore({ adapters: [db] });
    const seen = await watchA(s);
    const readsBefore = db.reads;

    await writeDb({});
    await touchWal();
    await vi.waitFor(() => expect(db.reads).toBeGreaterThan(readsBefore), { timeout: 5000 });
    await sleep(100);

    expect(ids(seen.client().requests)).toEqual(['r1']);
    expect(seen.patches).toEqual([]);
  });
});

describe('SessionStore for the weekly receipt', () => {
  it('reads a session once without opening it, and says how large it is', async () => {
    const p = await session('w1', rec.req('r1', T(1)), rec.req('r2', T(2)));
    const s = await startStore();
    const size = await s.sizeOf(p.id);
    expect(size).toBe((await readFile(p.main)).length);
    const got = await s.readSession(p.id);
    expect(got?.snapshot.requests).toHaveLength(2);
    expect(got?.bytes).toBe(size);
    expect(fake.parsersFor('w1')).toHaveLength(1);
  });

  it('waits for a session being opened rather than parsing it a second time (M9)', async () => {
    const p = await session('w2', rec.req('r1', T(1)));
    const s = await startStore();
    const opening = s.getSnapshot(p.id);
    const got = await s.readSession(p.id);
    await opening;
    expect(got?.snapshot.requests).toHaveLength(1);
    expect(fake.parsersFor('w2')).toHaveLength(1);
    // Open: a read goes through no file.
    expect(await s.sizeOf(p.id)).toBe(0);
  });

  it('stops its week with it, dropping a read under way (M9)', async () => {
    const p = await session('w3', rec.req('r1', T(1)));
    const s = await startStore();
    const reading = s.readSession(p.id);
    await s.stop();
    store = undefined;
    expect(await reading).toBeNull();
    await expect(s.week.compute('week')).rejects.toThrow('stopped');
  });

  it('cuts a read under way short at its next chunk when the store stops (M9)', async () => {
    const many = Array.from({ length: 3000 }, (_, i) => rec.req(`r${i}`, T(1)));
    const p = await session('w4', ...many);
    // A whole read, for how many chunks it takes.
    const whole = await startStore({ chunkBytes: 256 });
    expect((await whole.readSession(p.id))?.snapshot.requests).toHaveLength(3000);
    const chunks = fake.parsersFor('w4')[0]?.ingested.length ?? 0;
    expect(chunks).toBeGreaterThan(100);
    await whole.stop();
    // The same read, the store stopping a few chunks in.
    const s = await startStore({ chunkBytes: 256 });
    const reading = s.readSession(p.id);
    const parser = () => fake.parsersFor('w4')[1];
    for (let i = 0; i < 500 && (parser()?.ingested.length ?? 0) === 0; i++)
      await new Promise((r) => setImmediate(r));
    await s.stop();
    store = undefined;
    expect(await reading).toBeNull();
    const read = parser()?.ingested.length ?? 0;
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(chunks / 2);
  });
});
