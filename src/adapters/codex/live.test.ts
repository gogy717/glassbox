/**
 * The Codex adapter behind the real server store: files that change under an open session.
 */
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '../../core/model.js';
import { applyPatch } from '../../server/__tests__/apply-patch.js';
import { SessionStore } from '../../server/store.js';
import {
  CHILD_ID,
  gardenSession,
  line,
  SESSION_ID,
  sessionMeta,
  TURN_1,
  usage,
} from './__fixtures__/builders.js';
import { createCodexAdapter } from './index.js';

let codexDir: string;
let store: SessionStore | undefined;

beforeEach(async () => {
  codexDir = await realpath(await mkdtemp(join(tmpdir(), 'glassbox-codex-live-')));
});
afterEach(async () => {
  await store?.stop();
  store = undefined;
  await rm(codexDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const day = () => join(codexDir, 'sessions', '2026', '01', '01');
const id = `codex:${SESSION_ID}`;

async function put(path: string, content: string | Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const turn = (ordinal: number) =>
  line('event_msg', ordinal, ordinal, { type: 'task_started', turn_id: TURN_1 });
const spent = (ordinal: number, responseId: string) =>
  usage({ ordinal, sec: ordinal, responseId, turnId: TURN_1, input: 10, output: 5 });

/** A parent with one request and a child with one: their plain paths. */
async function parentAndChild(): Promise<{ main: string; child: string }> {
  const main = join(day(), `rollout-2026-01-01T00-00-00-${SESSION_ID}.jsonl`);
  await put(main, `${[sessionMeta(), turn(1), spent(2, 'resp_p')].join('\n')}\n`);
  const child = join(day(), `rollout-2026-01-01T00-00-01-${CHILD_ID}.jsonl`);
  await put(
    child,
    `${[
      sessionMeta({ id: CHILD_ID, session_id: CHILD_ID, parent_thread_id: SESSION_ID }),
      turn(1),
      spent(2, 'resp_c'),
    ].join('\n')}\n`,
  );
  return { main, child };
}

async function startStore(home = codexDir) {
  store = new SessionStore({
    adapters: [createCodexAdapter({ codexDir: home })],
    // Files change between two scans (5 s in production): nothing here may wait for one.
    discoverMs: 60_000,
    liveMs: 50,
    pollMs: 50,
    sessionsMs: 20,
  });
  await store.start();
  return store;
}

const requestIds = (snap: SessionSnapshot | null | undefined) =>
  (snap?.requests ?? []).map((r) => r.id).sort();

describe('a rollout compressed in place under an open session', () => {
  it.each([
    ['child', 'the archive is written, then the plain file removed', 'archive-first'],
    ['child', 'the plain file is removed, then the archive written', 'remove-first'],
    ['main', 'the archive is written, then the plain file removed', 'archive-first'],
    ['main', 'the plain file is removed, then the archive written', 'remove-first'],
  ] as const)(
    'keeps the %s rollout when %s, counting nothing twice',
    async (which, _name, order) => {
      const paths = await parentAndChild();
      const child = paths[which];
      const s = await startStore();
      const before = (await s.getSnapshot(id)) as SessionSnapshot;
      expect(requestIds(before)).toEqual(['resp_c', 'resp_p']);
      let client = before;
      let rebuilds = 0;
      s.onPatch(
        id,
        (patch) => {
          client = applyPatch(client, patch);
        },
        (snap) => {
          client = snap;
          rebuilds += 1;
        },
      );
      const archive = zstdCompressSync(await readFile(child));

      if (order === 'archive-first') {
        await put(`${child}.zst`, archive);
        await sleep(150);
        await rm(child);
      } else {
        await rm(child);
        await sleep(300);
        await put(`${child}.zst`, archive);
      }

      await vi.waitFor(
        async () => {
          // The plain file is gone, so the session was read again from what is on disk.
          expect(rebuilds).toBeGreaterThan(0);
          const after = (await s.getSnapshot(id)) as SessionSnapshot;
          expect(requestIds(after)).toEqual(['resp_c', 'resp_p']);
          expect(after.session.usage).toEqual(before.session.usage);
          expect(client).toEqual(after);
        },
        { timeout: 3000 },
      );
    },
  );
});

describe('a sub-agent that starts under an open session', () => {
  it('is followed even when the watcher first sees its rollout empty', async () => {
    const main = join(day(), `rollout-2026-01-01T00-00-00-${SESSION_ID}.jsonl`);
    await put(main, `${[sessionMeta(), turn(1), spent(2, 'resp_p')].join('\n')}\n`);
    const s = await startStore();
    expect(requestIds(await s.getSnapshot(id))).toEqual(['resp_p']);
    s.onPatch(
      id,
      () => {},
      () => {},
    );
    const child = join(day(), `rollout-2026-01-01T00-00-01-${CHILD_ID}.jsonl`);
    // Codex creates the file, then writes its header.
    await put(child, '');
    await sleep(300);
    await appendFile(
      child,
      `${[
        sessionMeta({ id: CHILD_ID, session_id: CHILD_ID, parent_thread_id: SESSION_ID }),
        turn(1),
        spent(2, 'resp_c'),
      ].join('\n')}\n`,
    );
    await vi.waitFor(
      async () => expect(requestIds(await s.getSnapshot(id))).toEqual(['resp_c', 'resp_p']),
      { timeout: 3000 },
    );
  });
});

describe('a Codex home reached through a symlink', () => {
  let linkDir: string;
  beforeEach(async () => {
    linkDir = await mkdtemp(join(tmpdir(), 'glassbox-codex-link-'));
  });
  afterEach(async () => {
    await rm(linkDir, { recursive: true, force: true });
  });

  it('reads a rollout being written once, not once per name', async () => {
    const home = join(linkDir, 'codex');
    await symlink(codexDir, home);
    const now = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    // Today's folder: watched for new sub-agents as well as for this session's own file.
    const today = join(
      codexDir,
      'sessions',
      String(now.getFullYear()),
      two(now.getMonth() + 1),
      two(now.getDate()),
    );
    const main = join(today, `rollout-2026-01-01T00-00-00-${SESSION_ID}.jsonl`);
    const all = gardenSession();
    await put(main, `${all.slice(0, 5).join('\n')}\n`);
    const s = await startStore(home);
    expect((await s.getSnapshot(id))?.turns).toHaveLength(1);
    s.onPatch(
      id,
      () => {},
      () => {},
    );

    await appendFile(main, `${all.slice(5).join('\n')}\n`);

    const fresh = createCodexAdapter({ codexDir });
    const [source] = await fresh.discover();
    if (!source) throw new Error('no session');
    const parser = fresh.createParser(source);
    const [file] = await fresh.listFiles(source);
    if (!file) throw new Error('no file');
    parser.ingestLines(file, all);
    const settled = async () => {
      const after = (await s.getSnapshot(id)) as SessionSnapshot;
      parser.setLive(after.session.live);
      // Stamped when each parser was told the live state; the sign of trouble is the server's.
      const stamp = (snap: SessionSnapshot) => ({
        ...snap,
        session: { ...snap.session, updatedAt: null, trouble: undefined },
      });
      expect(stamp(after)).toEqual(stamp(parser.snapshot()));
    };
    await vi.waitFor(settled, { timeout: 3000 });
    // Every watcher has had several polls to report the file under another name.
    await sleep(300);
    await settled();
  });
});
