import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { journalProblem, journalUsable } from '../sqlite.js';
import { ms, ROOT_ID, SessionBuilder, text, tokens } from './__fixtures__/builders.js';
import { createDb, insertRows, WriterProcess } from './__fixtures__/harness.js';
import { OpenCodeDb } from './db.js';

let dir: string;
let path: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glassbox-opencode-'));
  path = join(dir, 'opencode.db');
  logs = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const openDb = (io = {}) => new OpenCodeDb(path, (m) => logs.push(m), io);

/** Mode, size, mtime and content hash of the database and the files SQLite keeps beside it. */
function files(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['opencode.db', 'opencode.db-wal', 'opencode.db-shm']) {
    const p = join(dir, name);
    if (!existsSync(p)) {
      out[name] = 'absent';
      continue;
    }
    const st = statSync(p);
    const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
    out[name] = `${(st.mode & 0o777).toString(8)} ${st.size} ${st.mtimeMs} ${sha}`;
  }
  return out;
}

function twoSessions() {
  const b = new SessionBuilder({ updatedSec: 5 });
  const child = b.session({
    parent_id: ROOT_ID,
    title: 'Look (@explore subagent)',
    createdSec: 2,
    updatedSec: 9,
  });
  b.session({ id: 'ses_other', title: 'Another', createdSec: 50 });
  const u = b.user(ROOT_ID, 1, text('go'));
  const a = b.assistant(ROOT_ID, u, 2, { finish: 'stop', tokens: tokens(5, 1) });
  b.part(a, 2, text('ok', 2, 3));
  const cu = b.user(child, 3, text('look'));
  b.assistant(child, cu, 4, { finish: 'stop' });
  return { b, child, u, a };
}

describe('OpenCodeDb reads', () => {
  it('lists every session row', async () => {
    createDb(path, twoSessions().b.doc()).close();
    const rows = await openDb().sessions();
    expect(rows?.map((r) => r.id).sort()).toEqual(
      [ROOT_ID, 'ses_other', expect.stringMatching(/^ses_/)].sort(),
    );
  });

  it('reads a session with every session below it, root first, and nothing else', async () => {
    const { b, child } = twoSessions();
    createDb(path, b.doc()).close();
    const tree = await openDb().tree(ROOT_ID);
    expect(tree?.value.sessions.map((s) => s.id)).toEqual([ROOT_ID, child]);
    expect(tree?.value.messages).toHaveLength(4);
    expect(tree?.value.parts).toHaveLength(3);
    expect(new Set(tree?.value.messages.map((m) => m.session_id))).toEqual(
      new Set([ROOT_ID, child]),
    );
  });

  it('hands back the same document while nothing changed, and only re-reads what did', async () => {
    const { b, a } = twoSessions();
    const writer = createDb(path, b.doc());
    const db = openDb();
    const first = await db.tree(ROOT_ID);
    expect(await db.tree(ROOT_ID)).toBe(first);

    const p = b.part(a, 30, text('more', 30, 31));
    insertRows(writer, { parts: b.parts.filter((x) => x.id === p) });
    const second = await db.tree(ROOT_ID);
    expect(second?.version).not.toBe(first?.version);
    expect(second?.value.parts.map((x) => x.id)).toContain(p);
    // Rows that did not change are the very objects read before.
    expect(second?.value.messages[0]).toBe(first?.value.messages[0]);
    writer.close();
  });

  it('notices deleted rows (a revert), even when as many were added', async () => {
    const { b, u } = twoSessions();
    const writer = createDb(path, b.doc());
    const db = openDb();
    expect((await db.tree(ROOT_ID))?.value.messages.map((m) => m.id)).toContain(u);

    writer.exec(`DELETE FROM message WHERE id = '${u}'`);
    const tree = await db.tree(ROOT_ID);
    expect(tree?.value.messages.map((m) => m.id)).not.toContain(u);
    writer.close();
  });

  it('gives the newest message of each recently updated session for live status', async () => {
    const { b, child } = twoSessions();
    createDb(path, b.doc()).close();
    // The cutoff leaves out the root (updated at 5 s); 'ses_other' has no message yet.
    const activity = await openDb().activity(b.sessions[1]?.time_updated ?? 0);
    expect(activity?.sessions).toHaveLength(3);
    expect([...(activity?.latest.keys() ?? [])]).toEqual([child]);
    expect(activity?.latest.get(child)?.row.data).toContain('"role":"assistant"');
  });

  it('dates the newest message by its latest write, parts included', async () => {
    const b = new SessionBuilder({ updatedSec: 2 });
    const u = b.user(ROOT_ID, 1, text('go'));
    const a = b.assistant(ROOT_ID, u, 2, { completedSec: null });
    // A tool part written an hour later; neither the session nor the message row moved.
    b.part(a, 3600, text('still going', 3600));
    createDb(path, b.doc()).close();
    const latest = (await openDb().activity(0))?.latest.get(ROOT_ID);
    expect(latest?.row.id).toBe(a);
    expect(latest?.writtenMs).toBe(ms(3600));
  });

  it('reads a tree with more sessions than it caches, whole, again and again', async () => {
    const b = new SessionBuilder();
    const u = b.user(ROOT_ID, 1, text('fan out'));
    b.assistant(ROOT_ID, u, 2, { finish: 'stop' });
    for (let i = 0; i < 70; i++) {
      const child = b.session({ parent_id: ROOT_ID, title: `Worker ${i}`, createdSec: 3 + i });
      b.user(child, 3 + i, text(`job ${i}`));
    }
    b.session({ id: 'ses_small', title: 'Small', createdSec: 200 });
    b.user('ses_small', 200, text('hi'));
    createDb(path, b.doc()).close();
    const db = openDb();
    const sizes = (tree: Awaited<ReturnType<OpenCodeDb['tree']>>) => [
      tree?.value.sessions.length,
      tree?.value.messages.length,
      tree?.value.parts.length,
    ];

    expect(sizes(await db.tree(ROOT_ID))).toEqual([71, 72, 71]);
    expect(sizes(await db.tree(ROOT_ID))).toEqual([71, 72, 71]);
    expect(sizes(await db.tree('ses_small'))).toEqual([1, 1, 1]);
    expect(sizes(await db.tree(ROOT_ID))).toEqual([71, 72, 71]);
  });

  it('answers null for a missing database and logs it once until it can be read again', async () => {
    const db = openDb();
    expect(await db.sessions()).toBeNull();
    expect(await db.tree(ROOT_ID)).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(path);

    createDb(path, twoSessions().b.doc()).close();
    expect(await db.sessions()).toHaveLength(3);
    rmSync(path);
    expect(await db.sessions()).toBeNull();
    expect(logs).toHaveLength(2);
  });

  it('refuses an empty database file rather than opening it', async () => {
    writeFileSync(path, '');
    chmodSync(path, 0o600);
    expect(await openDb().sessions()).toBeNull();
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
  });
});

describe('OpenCodeDb never changes OpenCode files', () => {
  it('creates nothing when there is no journal (OpenCode not running)', async () => {
    createDb(path, twoSessions().b.doc()).close();
    expect(existsSync(`${path}-wal`)).toBe(false);
    const before = files();
    expect(await openDb().tree(ROOT_ID)).not.toBeNull();
    expect(files()).toEqual(before);
  });

  it('leaves an empty journal with another mode alone', async () => {
    createDb(path, twoSessions().b.doc()).close();
    chmodSync(path, 0o600);
    writeFileSync(`${path}-wal`, '');
    chmodSync(`${path}-wal`, 0o644);
    const before = files();
    expect(await openDb().sessions()).toHaveLength(3);
    expect(files()).toEqual(before);
  });

  it('reads rows only the journal holds while OpenCode runs, touching no file', async () => {
    const { b, a } = twoSessions();
    const writer = await WriterProcess.create(path, b.doc());
    const p = b.part(a, 40, text('fresh', 40, 41));
    await writer.insert({ parts: b.parts.filter((x) => x.id === p) });
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    expect(journalUsable(path)).toBe(true);

    const before = files();
    const tree = await openDb().tree(ROOT_ID);
    expect(tree?.value.parts.map((x) => x.id)).toContain(p);
    expect(files()).toEqual(before);
    await writer.close();
  });

  it('reads the journal an OpenCode killed mid-write left behind, touching no file', async () => {
    const { b, a } = twoSessions();
    const writer = await WriterProcess.create(path, b.doc());
    await writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const p = b.part(a, 40, text('only in the journal', 40, 41));
    await writer.insert({ parts: b.parts.filter((x) => x.id === p) });
    await writer.kill();
    // No connection is left: the next reader would normally rebuild -shm.
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    expect(existsSync(`${path}-shm`)).toBe(true);

    const before = files();
    const tree = await openDb().tree(ROOT_ID);
    expect(tree?.value.parts.map((x) => x.id)).toContain(p);
    expect(files()).toEqual(before);
  });

  it('says why it skips a journal that holds pages', async () => {
    const { b, a } = twoSessions();
    const writer = await WriterProcess.create(path, b.doc());
    await writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const p = b.part(a, 40, text('fresh', 40, 41));
    await writer.insert({ parts: b.parts.filter((x) => x.id === p) });
    await writer.kill();
    rmSync(`${path}-shm`);
    expect(journalProblem(path)).toBe('its -shm is missing');
    await openDb().sessions();
    expect(logs).toEqual([`reading only the checkpointed part of ${path}: its -shm is missing`]);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  it('reads only checkpointed rows when the journal has another mode than the database', async () => {
    const { b, a } = twoSessions();
    const writer = await WriterProcess.create(path, b.doc());
    await writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const p = b.part(a, 40, text('fresh', 40, 41));
    await writer.insert({ parts: b.parts.filter((x) => x.id === p) });
    chmodSync(path, 0o600);
    expect(journalUsable(path)).toBe(false);

    const before = files();
    const db = openDb();
    const tree = await db.tree(ROOT_ID);
    expect(tree?.value.parts.map((x) => x.id)).not.toContain(p);
    await db.sessions();
    expect(files()).toEqual(before);
    expect(logs.filter((m) => m.includes('checkpointed'))).toEqual([
      `reading only the checkpointed part of ${path}: its -wal has mode 644, the database 600`,
    ]);
    await writer.close();
  });

  it.each([
    ['the same mode as the database', 0o644],
    ['another mode than the database', 0o600],
  ])(
    'changes no mode when OpenCode empties a journal with %s just before the open',
    async (_name, dbMode) => {
      const { b, a } = twoSessions();
      const writer = await WriterProcess.create(path, b.doc());
      const p = b.part(a, 40, text('fresh', 40, 41));
      await writer.insert({ parts: b.parts.filter((x) => x.id === p) });
      chmodSync(path, dbMode);
      chmodSync(`${path}-wal`, 0o644);
      chmodSync(`${path}-shm`, 0o644);
      const modes = () =>
        ['', '-wal', '-shm'].map((s) => (statSync(`${path}${s}`).mode & 0o777).toString(8));
      const before = modes();

      // OpenCode checkpoints between the decision how to open and the open itself.
      let raced = false;
      const db = openDb({
        beforeOpen: () => {
          if (raced) return;
          raced = true;
          const checkpointer = new DatabaseSync(path);
          checkpointer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          checkpointer.close();
        },
      });
      expect(await db.sessions()).toHaveLength(3);
      expect(statSync(`${path}-wal`).size).toBe(0);
      expect(modes()).toEqual(before);
      await writer.close();
    },
  );
});
