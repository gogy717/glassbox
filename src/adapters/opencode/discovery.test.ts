import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSnapshot } from '../../core/invariants.js';
import type { SessionPatch, SessionSnapshot } from '../../core/model.js';
import { applyPatch } from '../../server/__tests__/apply-patch.js';
import { SessionStore } from '../../server/store.js';
import { at, ms, ROOT_ID, SessionBuilder, text, tokens } from './__fixtures__/builders.js';
import { createDb, WriterProcess } from './__fixtures__/harness.js';
import { OpenCodeDb } from './db.js';
import {
  classifyPath,
  discoverSessions,
  newLiveCache,
  opencodeRunning,
  readLiveStatus,
} from './discovery.js';
import { createOpenCodeAdapter } from './index.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glassbox-opencode-'));
  path = join(dir, 'opencode.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('discoverSessions', () => {
  it('lists root sessions only, each updated as recently as anything in its tree', async () => {
    const b = new SessionBuilder({ createdSec: 1, updatedSec: 10 });
    b.session({
      parent_id: ROOT_ID,
      title: 'Look (@explore subagent)',
      createdSec: 2,
      updatedSec: 30,
    });
    b.session({
      id: 'ses_untitled',
      title: 'New session - 2026-01-01T00:01:00.000Z',
      directory: '/',
      createdSec: 60,
      updatedSec: 61,
    });
    createDb(path, b.doc()).close();

    const sources = await discoverSessions(new OpenCodeDb(path), new Map([[ROOT_ID, 'busy']]));
    expect(sources.map((s) => s.nativeId).sort()).toEqual([ROOT_ID, 'ses_untitled'].sort());
    const root = sources.find((s) => s.nativeId === ROOT_ID);
    expect(root).toEqual({
      agent: 'opencode',
      nativeId: ROOT_ID,
      location: path,
      summary: {
        id: `opencode:${ROOT_ID}`,
        agent: 'opencode',
        nativeId: ROOT_ID,
        title: 'Garden chores',
        cwd: '/home/user/garden',
        project: 'garden',
        startedAt: at(1),
        updatedAt: at(30),
        live: 'busy',
        version: '1.19.4',
        model: 'free-model-1',
        usage: null,
        counts: null,
      },
    });
    expect(sources.find((s) => s.nativeId === 'ses_untitled')?.summary).toMatchObject({
      title: null,
      project: '/',
      live: 'closed',
    });
  });

  it('shows a sub-agent whose parent is gone as a session of its own', async () => {
    const b = new SessionBuilder();
    b.session({ id: 'ses_orphan', parent_id: 'ses_deleted', title: 'Orphan' });
    createDb(path, b.doc()).close();
    const ids = (await discoverSessions(new OpenCodeDb(path))).map((s) => s.nativeId);
    expect(ids.sort()).toEqual([ROOT_ID, 'ses_orphan'].sort());
  });

  it('finds nothing in a database it cannot read', async () => {
    expect(await discoverSessions(new OpenCodeDb(path))).toEqual([]);
  });
});

describe('classifyPath', () => {
  it('maps the database and its journal to the session, and nothing else', () => {
    expect(classifyPath(path, path)).toMatchObject({ path, format: 'json', role: 'session' });
    expect(classifyPath(path, `${path}-wal`)).toMatchObject({ path, role: 'session' });
    expect(classifyPath(path, `${path}-shm`)).toBeNull();
    expect(classifyPath(path, join(dir, 'auth.json'))).toBeNull();
  });
});

describe('readLiveStatus', () => {
  /** A root whose sub-agent is mid-call (its newest message has no completion time). */
  function midCall(updatedSec: number) {
    const b = new SessionBuilder({ updatedSec });
    const child = b.session({ parent_id: ROOT_ID, title: 'Look', createdSec: 1, updatedSec });
    const u = b.user(ROOT_ID, 1, text('go'));
    b.assistant(ROOT_ID, u, 2, { completedSec: null });
    const cu = b.user(child, 3, text('look'));
    b.assistant(child, cu, 4, { completedSec: null });
    b.session({ id: 'ses_done', createdSec: 5, updatedSec });
    const du = b.user('ses_done', 5, text('hi'));
    b.assistant('ses_done', du, 6, { finish: 'stop', tokens: tokens(1, 1) });
    createDb(path, b.doc()).close();
    return new OpenCodeDb(path);
  }

  it('calls a session tree busy while one of its calls is unfinished and OpenCode runs', async () => {
    const db = midCall(100);
    const live = await readLiveStatus(db, newLiveCache(), {
      now: () => ms(200),
      running: async () => true,
    });
    expect([...live]).toEqual([[ROOT_ID, 'busy']]);
  });

  it('calls everything closed when no OpenCode process runs, without reading the database', async () => {
    const db = new OpenCodeDb(join(dir, 'missing.db'));
    const activity = vi.spyOn(db, 'activity');
    const live = await readLiveStatus(db, newLiveCache(), { running: async () => false });
    expect(live.size).toBe(0);
    expect(activity).not.toHaveBeenCalled();
  });

  it('wants a recent write where processes cannot be listed', async () => {
    const db = midCall(100);
    const io = (nowSec: number) => ({ now: () => ms(nowSec), running: async () => null });
    expect((await readLiveStatus(db, newLiveCache(), io(100 + 5 * 60))).size).toBe(1);
    expect((await readLiveStatus(db, newLiveCache(), io(100 + 20 * 60))).size).toBe(0);
  });

  it('counts a part written during a long step as recent, though the session row did not move', async () => {
    const b = new SessionBuilder({ updatedSec: 2 });
    const u = b.user(ROOT_ID, 1, text('build'));
    const a = b.assistant(ROOT_ID, u, 2, { completedSec: null });
    b.part(a, 2 + 3 * 3600, text('still building', 2 + 3 * 3600));
    createDb(path, b.doc()).close();
    const live = await readLiveStatus(new OpenCodeDb(path), newLiveCache(), {
      now: () => ms(2 + 3 * 3600 + 60),
      running: async () => true,
    });
    expect([...live]).toEqual([[ROOT_ID, 'busy']]);
  });

  it('forgets an unfinished call that is older than an hour even while OpenCode runs', async () => {
    const live = await readLiveStatus(midCall(100), newLiveCache(), {
      now: () => ms(100 + 2 * 3600),
      running: async () => true,
    });
    expect(live.size).toBe(0);
  });

  it('keeps the last answer while the database cannot be read, and reuses a process listing', async () => {
    const db = midCall(100);
    const cache = newLiveCache();
    const running = vi.fn(async () => true);
    await readLiveStatus(db, cache, { now: () => ms(200), running });
    rmSync(path);
    const live = await readLiveStatus(db, cache, { now: () => ms(202), running });
    expect([...live]).toEqual([[ROOT_ID, 'busy']]);
    expect(running).toHaveBeenCalledTimes(1);
  });
});

describe('opencodeRunning', () => {
  it('answers with a boolean on a system it can list, or null', async () => {
    const answer = await opencodeRunning();
    expect(answer === null || typeof answer === 'boolean').toBe(true);
    if (process.platform === 'linux') expect(typeof answer).toBe('boolean');
  });
});

describe('OpenCode adapter in the store', () => {
  let store: SessionStore | undefined;
  afterEach(async () => {
    await store?.stop();
    store = undefined;
  });

  it('serves a session from the database and follows OpenCode’s writes to it', async () => {
    const b = new SessionBuilder();
    const u = b.user(ROOT_ID, 1, text('go'));
    const a = b.assistant(ROOT_ID, u, 2, { finish: 'stop', tokens: tokens(7, 3) });
    b.part(a, 2, text('first', 2, 3));
    const writer = await WriterProcess.create(path, b.doc());
    store = new SessionStore({
      adapters: [createOpenCodeAdapter({ opencodeDir: dir }, { running: async () => false })],
      discoverMs: 50,
      liveMs: 50,
      pollMs: 50,
      sessionsMs: 20,
    });
    await store.start();
    const id = `opencode:${ROOT_ID}`;
    expect(store.listSessions().map((s) => s.id)).toEqual([id]);

    let client = (await store.getSnapshot(id)) as SessionSnapshot;
    expect(checkSnapshot(client)).toEqual([]);
    expect(client.session.usage).toMatchObject({ input: 7, output: 3 });
    const patches: SessionPatch[] = [];
    store.onPatch(id, (patch) => {
      patches.push(patch);
      client = applyPatch(client, patch);
    });

    const u2 = b.user(ROOT_ID, 10, text('again'));
    const a2 = b.assistant(ROOT_ID, u2, 11, { finish: 'stop', tokens: tokens(5, 2) });
    await writer.insert({
      messages: b.messages.filter((m) => m.id === u2 || m.id === a2),
      parts: b.parts.filter((p) => p.message_id === u2),
    });

    await vi.waitFor(() => expect(client.requests.map((r) => r.id)).toEqual([a, a2]), {
      timeout: 3000,
    });
    expect(client).toEqual(await store.getSnapshot(id));
    expect(client.session.usage).toMatchObject({ input: 12, output: 5 });
    expect(patches.length).toBeGreaterThan(0);
    await writer.close();
  });

  it('patches only the session OpenCode wrote to when two of its sessions are open', async () => {
    const b = new SessionBuilder();
    const u = b.user(ROOT_ID, 1, text('one'));
    b.assistant(ROOT_ID, u, 2, { finish: 'stop', tokens: tokens(1, 1) });
    const other = b.session({ id: 'ses_other', title: 'Other', createdSec: 5 });
    const ou = b.user(other, 5, text('two'));
    b.assistant(other, ou, 6, { finish: 'stop', tokens: tokens(2, 2) });
    const writer = await WriterProcess.create(path, b.doc());
    store = new SessionStore({
      adapters: [createOpenCodeAdapter({ opencodeDir: dir }, { running: async () => false })],
      discoverMs: 50,
      liveMs: 50,
      pollMs: 50,
      sessionsMs: 20,
    });
    await store.start();
    const seen: Record<string, SessionPatch[]> = { [ROOT_ID]: [], [other]: [] };
    for (const nativeId of [ROOT_ID, other]) {
      await store.getSnapshot(`opencode:${nativeId}`);
      store.onPatch(`opencode:${nativeId}`, (patch) => seen[nativeId]?.push(patch));
    }

    const u2 = b.user(ROOT_ID, 10, text('again'));
    await writer.insert({
      messages: b.messages.filter((m) => m.id === u2),
      parts: b.parts.filter((p) => p.message_id === u2),
    });

    await vi.waitFor(
      () => expect(seen[ROOT_ID]?.flatMap((p) => p.turns.map((t) => t.id))).toContain(u2),
      {
        timeout: 3000,
      },
    );
    // Both sessions re-read the database; only the one that changed has news.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen[other]).toEqual([]);
    await writer.close();
  });
});
