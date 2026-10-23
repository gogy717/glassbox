/**
 * The oh-my-pi adapter behind the real server store: files that change under an open session.
 */
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '../../core/model.js';
import { applyPatch } from '../../server/__tests__/apply-patch.js';
import { SessionStore } from '../../server/store.js';
import { at, header, SESSION_ID, Transcript, titleSlot } from './__fixtures__/builders.js';
import { createOmpAdapter } from './index.js';

let ompDir: string;
let store: SessionStore | undefined;
const id = `oh-my-pi:${SESSION_ID}`;
const sessionPath = () =>
  join(ompDir, 'agent', 'sessions', '-work-garden', `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
const stem = () => sessionPath().slice(0, -'.jsonl'.length);
const lines = (rows: string[]) => `${rows.join('\n')}\n`;

beforeEach(async () => {
  ompDir = await realpath(await mkdtemp(join(tmpdir(), 'glassbox-omp-store-')));
});
afterEach(async () => {
  await store?.stop();
  store = undefined;
  await rm(ompDir, { recursive: true, force: true });
});

async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function startStore() {
  store = new SessionStore({
    adapters: [createOmpAdapter({ ompDir })],
    discoverMs: 60_000,
    liveMs: 50,
    pollMs: 50,
    sessionsMs: 20,
  });
  await store.start();
  return store;
}

describe('an open oh-my-pi session', () => {
  it('follows new entries, a sub-agent that starts later, and its own sub-agent', async () => {
    const t = new Transcript();
    t.user('Survey the garden', 1);
    await put(sessionPath(), lines([titleSlot(''), header(), ...t.lines]));
    const s = await startStore();
    let client = (await s.getSnapshot(id)) as SessionSnapshot;
    expect(client.turns.map((x) => x.prompt)).toEqual(['Survey the garden']);
    s.onPatch(
      id,
      (patch) => {
        client = applyPatch(client, patch);
      },
      (snap) => {
        client = snap;
      },
    );

    const before = t.lines.length;
    t.answer({
      sec: 2,
      tools: [{ id: 'c-task', name: 'task', args: { tasks: [{ name: 'Scout', task: 'Count' }] } }],
    });
    t.toolStart('c-task', 'task', 2);
    t.entry('title_change', 2, { title: '🌱 GARDEN: Survey', source: 'auto' });
    await appendFile(sessionPath(), lines(t.lines.slice(before)));

    // The dir beside the session does not exist yet when it is opened.
    const scout = new Transcript('s');
    scout.user('Count', 3, { attribution: 'agent' });
    scout.answer({
      sec: 4,
      tools: [{ id: 'c-sub', name: 'task', args: { name: 'Helper', task: 'Measure' } }],
    });
    await put(
      join(stem(), 'Scout.jsonl'),
      lines([header({ id: 'sub-1', timestamp: at(3) }), ...scout.lines]),
    );
    await put(join(stem(), '0.bash.log'), 'an artifact is not a transcript');

    // Scout's own dir appears only once Scout spawns.
    const helper = new Transcript('h');
    helper.user('Measure', 5, { attribution: 'agent' });
    helper.answer({ sec: 6, text: '2 m' });
    await vi.waitFor(async () => {
      const snap = (await s.getSnapshot(id)) as SessionSnapshot;
      expect(snap.agents.map((a) => a.id)).toEqual(['main', 'Scout']);
    });
    await put(
      join(stem(), 'Scout', 'Helper.jsonl'),
      lines([header({ id: 'sub-2', timestamp: at(5) }), ...helper.lines]),
    );

    await vi.waitFor(
      async () => {
        const snap = (await s.getSnapshot(id)) as SessionSnapshot;
        expect(snap.session.title).toBe('GARDEN: Survey');
        expect(snap.agents.map((a) => [a.id, a.parentId, a.spawnedByToolCallId])).toEqual([
          ['main', null, null],
          ['Scout', 'main', 'c-task'],
          ['Scout/Helper', 'Scout', 'Scout/c-sub'],
        ]);
        expect(client).toEqual(snap);
      },
      { timeout: 3000 },
    );
  });
});
