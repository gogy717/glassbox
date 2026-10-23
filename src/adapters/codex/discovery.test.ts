import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSnapshot } from '../../core/invariants.js';
import { at, CWD, line } from './__fixtures__/builders.js';
import { readRolloutText, resolveDecompress } from './discovery.js';
import { createCodexAdapter } from './index.js';

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const GHOST = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

let codexDir: string;

async function put(path: string, content: string | Buffer) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

function meta(id: string, over: Record<string, unknown> = {}): string {
  return `${line('session_meta', 0, 0, {
    id,
    session_id: id,
    timestamp: at(0),
    cwd: CWD,
    cli_version: '0.153.4',
    ...over,
  })}\n`;
}

beforeEach(async () => {
  codexDir = await realpath(await mkdtemp(join(tmpdir(), 'glassbox-codex-')));
});
afterEach(async () => {
  await rm(codexDir, { recursive: true, force: true });
});

describe('discover', () => {
  it('reads a rollout header and a title from session_index, not from sqlite', async () => {
    const path = join(
      codexDir,
      'sessions',
      '2026',
      '01',
      '01',
      `rollout-2026-01-01T00-00-00-${PARENT}.jsonl`,
    );
    await put(path, meta(PARENT));
    await put(
      join(codexDir, 'session_index.jsonl'),
      `${JSON.stringify({ id: PARENT, thread_name: 'Garden plan', updated_at: at(30) })}\n`,
    );
    await put(join(codexDir, 'auth.json'), '{');
    await put(join(codexDir, 'config.toml'), 'not = [');
    await put(join(codexDir, 'state_5.sqlite'), 'not a database');
    const sources = await createCodexAdapter({ codexDir }).discover();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ agent: 'codex', nativeId: PARENT, location: path });
    expect(sources[0]?.summary).toMatchObject({
      id: `codex:${PARENT}`,
      agent: 'codex',
      nativeId: PARENT,
      title: 'Garden plan',
      cwd: CWD,
      project: 'garden',
      startedAt: at(0),
      live: 'busy',
      version: '0.153.4',
      model: null,
      usage: null,
      counts: null,
    });
    expect(sources[0]?.summary.updatedAt).toEqual(expect.any(String));
  });

  it('marks a session busy only when its rollout was modified in the last 30s', async () => {
    const fresh = join(
      codexDir,
      'sessions',
      '2026',
      '01',
      '01',
      `rollout-2026-01-01T00-00-00-${PARENT}.jsonl`,
    );
    const stale = join(
      codexDir,
      'sessions',
      '2026',
      '01',
      '02',
      `rollout-2026-01-02T00-00-00-${CHILD}.jsonl`,
    );
    await put(fresh, meta(PARENT, { cwd: '/work/garden' }));
    await put(stale, meta(CHILD, { cwd: '/work/other' }));
    const old = new Date(Date.now() - 60_000);
    await utimes(stale, old, old);
    const live = new Map(
      (await createCodexAdapter({ codexDir }).discover()).map((s) => [s.nativeId, s.summary.live]),
    );
    expect(live.get(PARENT)).toBe('busy');
    expect(live.get(CHILD)).toBe('closed');
    expect(await createCodexAdapter({ codexDir }).liveStatus()).toEqual(
      new Map([[PARENT, 'busy']]),
    );
  });

  it('keeps a child rollout on its parent and still lists an orphan', async () => {
    const parent = join(
      codexDir,
      'sessions',
      '2026',
      '01',
      '01',
      `rollout-2026-01-01T00-00-00-${PARENT}.jsonl`,
    );
    const child = join(
      codexDir,
      'sessions',
      '2026',
      '01',
      '01',
      `rollout-2026-01-01T00-00-01-${PARENT}_${CHILD}.jsonl`,
    );
    const orphan = join(
      codexDir,
      'archived_sessions',
      `rollout-2026-01-01T00-00-02-${OTHER}.jsonl.zst`,
    );
    await put(parent, meta(PARENT));
    await put(child, meta(CHILD, { parent_thread_id: PARENT, cwd: '/work/garden' }));
    await put(
      orphan,
      zstdCompressSync(Buffer.from(meta(OTHER, { parent_thread_id: 'missing-parent' }))),
    );
    const adapter = createCodexAdapter({ codexDir });
    const sources = await adapter.discover();
    expect(sources.map((s) => s.nativeId).sort()).toEqual([OTHER, PARENT].sort());
    const parentSource = sources.find((s) => s.nativeId === PARENT);
    if (!parentSource) throw new Error('missing parent');
    const files = await adapter.listFiles(parentSource);
    expect(files.map((f) => `${f.role}:${f.path.endsWith('.jsonl')}`).sort()).toEqual([
      'rollout:true',
      'subagent:true',
    ]);
    expect(adapter.classify(parentSource, child)).toMatchObject({
      role: 'subagent',
      format: 'jsonl',
    });
    expect(adapter.classify(parentSource, join(codexDir, 'auth.json'))).toBeNull();
    expect(adapter.classify(parentSource, join(codexDir, 'config.toml'))).toBeNull();
    expect(adapter.watchDirs(parentSource)).toContain(
      join(codexDir, 'sessions', '2026', '01', '01'),
    );
    const parser = adapter.createParser(parentSource);
    const mainFile = files[0];
    const childFile = files.find((f) => f.role === 'subagent');
    if (!mainFile || !childFile) throw new Error('missing rollout file');
    const mainText = await readRolloutText(mainFile.path);
    const childText = await readRolloutText(childFile.path);
    if (mainText === null || childText === null) throw new Error('missing rollout text');
    parser.ingestLines(mainFile, mainText.split('\n'));
    parser.ingestLines(childFile, childText.split('\n'));
    const snap = parser.snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.agents.map((a) => a.id)).toEqual(['main', CHILD]);
    expect(snap.diagnostics.unavailable).toEqual(['live-state-heuristic']);
    expect(adapter.kind).toBe('codex');
  });

  it('decompresses a zstd rollout and skips one when zlib cannot', async () => {
    const plain = join(codexDir, 'sessions', 'day', `rollout-2026-01-01T00-00-00-${PARENT}.jsonl`);
    const archived = join(
      codexDir,
      'archived_sessions',
      `rollout-2026-01-01T00-00-00-${CHILD}.jsonl.zst`,
    );
    const broken = join(
      codexDir,
      'archived_sessions',
      `rollout-2026-01-01T00-00-00-${GHOST}.jsonl.zst`,
    );
    await put(plain, meta(PARENT));
    await put(archived, zstdCompressSync(Buffer.from(meta(CHILD))));
    await put(broken, Buffer.from('not zstd'));
    const text = await readRolloutText(archived);
    expect(text).toContain(CHILD);
    expect(await readRolloutText(archived, { decompress: undefined })).toBeNull();

    const ok = createCodexAdapter({ codexDir });
    const found = await ok.discover();
    expect(found.map((s) => s.nativeId).sort()).toEqual([CHILD, GHOST, PARENT].sort());
    const ghost = found.find((s) => s.nativeId === GHOST);
    if (!ghost) throw new Error('missing ghost');
    expect(await ok.listFiles(ghost)).toEqual([]);
    expect(ok.createParser(ghost).snapshot().diagnostics.unavailable).toEqual([
      'archived-sessions',
      'live-state-heuristic',
    ]);
    expect(checkSnapshot(ok.createParser(ghost).snapshot())).toEqual([]);
    const parent = found.find((s) => s.nativeId === PARENT);
    if (!parent) throw new Error('missing parent');
    expect(ok.createParser(parent).snapshot().diagnostics.unavailable).toEqual([
      'live-state-heuristic',
    ]);

    const blind = createCodexAdapter({ codexDir }, { decompress: undefined });
    const blindSources = await blind.discover();
    // Without a decompressor every single-uuid .jsonl.zst is unreadable, valid zstd or not.
    // Those files have no parent id, so every session from the scan is affected.
    expect(blindSources.map((s) => s.nativeId).sort()).toEqual([CHILD, GHOST, PARENT].sort());
    for (const source of blindSources) {
      expect(blind.createParser(source).snapshot().diagnostics.unavailable).toContain(
        'archived-sessions',
      );
    }
  });

  it('uses the session_meta id when the filename carries two uuids, and ignores a second path', async () => {
    const id = PARENT;
    const real = join(codexDir, 'sessions', 'day');
    const path = join(real, `rollout-2026-01-01T00-00-00-${OTHER}_${id}.jsonl`);
    await put(path, meta(id));
    await symlink(real, join(codexDir, 'sessions', 'alias'));
    const sources = await createCodexAdapter({ codexDir }).discover();
    expect(sources.map((s) => s.nativeId)).toEqual([id]);
  });

  it('returns nothing when the sessions directory is missing', async () => {
    expect(await createCodexAdapter({ codexDir }).discover()).toEqual([]);
  });

  it('does not treat a deflate blob as zstd', async () => {
    const path = join(
      codexDir,
      'archived_sessions',
      `rollout-2026-01-01T00-00-00-${PARENT}.jsonl.zst`,
    );
    await put(path, deflateSync(Buffer.from(meta(PARENT))));
    const sources = await createCodexAdapter({ codexDir }).discover();
    expect(sources.map((s) => s.nativeId)).toEqual([PARENT]);
    expect(sources[0] && (await createCodexAdapter({ codexDir }).listFiles(sources[0]))).toEqual(
      [],
    );
  });
});

describe('discover never fails as a whole', () => {
  it('a header with impossible times still lists its session, and others load', async () => {
    await put(
      join(codexDir, 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${PARENT}.jsonl`),
      `${line('session_meta', 0, 0, { id: PARENT, session_id: PARENT, timestamp: 1e300, cwd: CWD })}\n`,
    );
    await put(
      join(codexDir, 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-01-${OTHER}.jsonl`),
      meta(OTHER),
    );
    const ids = (await createCodexAdapter({ codexDir }).discover()).map((s) => s.nativeId).sort();
    expect(ids).toEqual([PARENT, OTHER].sort());
  });
});

describe('live watching', () => {
  const LATE = '55555555-5555-4555-8555-555555555555';
  const two = (n: number) => String(n).padStart(2, '0');
  const day = (y: string, m: string, d: string) => join(codexDir, 'sessions', y, m, d);
  const today = () => {
    const n = new Date();
    return day(String(n.getFullYear()), two(n.getMonth() + 1), two(n.getDate()));
  };
  const rollout = (dir: string, id: string) => join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`);

  it('watches the dated folders holding the session’s files, and today’s for new sub-agents', async () => {
    await put(rollout(day('2026', '01', '01'), PARENT), meta(PARENT));
    await put(rollout(day('2026', '01', '03'), CHILD), meta(CHILD, { parent_thread_id: PARENT }));
    const adapter = createCodexAdapter({ codexDir });
    const [source] = await adapter.discover();
    if (!source) throw new Error('no session');
    const dirs = adapter.watchDirs(source);
    expect(dirs).toEqual(
      expect.arrayContaining([day('2026', '01', '01'), day('2026', '01', '03'), today()]),
    );
    // The watcher is not recursive: a tree root would report nothing.
    expect(dirs).not.toContain(join(codexDir, 'sessions'));
  });

  it('claims a sub-agent rollout that appears after the last scan, and nothing else', async () => {
    await put(rollout(day('2026', '01', '01'), PARENT), meta(PARENT));
    const adapter = createCodexAdapter({ codexDir });
    const [source] = await adapter.discover();
    if (!source) throw new Error('no session');
    const child = rollout(today(), CHILD);
    const grandchild = rollout(today(), GHOST);
    const unrelated = rollout(today(), OTHER);
    const late = rollout(today(), LATE);
    await put(child, meta(CHILD, { parent_thread_id: PARENT }));
    await put(grandchild, meta(GHOST, { parent_thread_id: CHILD }));
    await put(unrelated, meta(OTHER));
    await put(late, '');
    expect(adapter.classify(source, child)).toMatchObject({ role: 'subagent', agentId: CHILD });
    expect(adapter.classify(source, grandchild)).toMatchObject({
      role: 'subagent',
      agentId: GHOST,
    });
    expect(adapter.classify(source, unrelated)).toBeNull();
    // Header not written yet: undecided now (the server asks again), claimed once it is.
    expect(adapter.classify(source, late)).toBe('later');
    await put(late, meta(LATE, { parent_thread_id: PARENT }));
    expect(adapter.classify(source, late)).toMatchObject({ role: 'subagent', agentId: LATE });
  });

  it('waits on a sub-agent whose parent is not known yet, and decides once it is', async () => {
    await put(rollout(day('2026', '01', '01'), PARENT), meta(PARENT));
    await put(rollout(day('2026', '01', '01'), OTHER), meta(OTHER));
    const adapter = createCodexAdapter({ codexDir });
    const source = (await adapter.discover()).find((s) => s.nativeId === PARENT);
    if (!source) throw new Error('no session');
    const child = rollout(today(), CHILD);
    const grandchild = rollout(today(), GHOST);
    const theirs = rollout(today(), LATE);
    await put(child, meta(CHILD, { parent_thread_id: PARENT }));
    await put(grandchild, meta(GHOST, { parent_thread_id: CHILD }));
    await put(theirs, meta(LATE, { parent_thread_id: OTHER }));
    // Reported before its parent: undecided, not foreign.
    expect(adapter.classify(source, grandchild)).toBe('later');
    expect(adapter.classify(source, child)).toMatchObject({ agentId: CHILD });
    expect(adapter.classify(source, grandchild)).toMatchObject({ agentId: GHOST });
    // Another session's sub-agent, its parent known: a final no.
    expect(adapter.classify(source, theirs)).toBeNull();
  });

  it('turns down a file whose first line is past the header cap, for good', async () => {
    await put(rollout(day('2026', '01', '01'), PARENT), meta(PARENT));
    const adapter = createCodexAdapter({ codexDir });
    const [source] = await adapter.discover();
    if (!source) throw new Error('no session');
    const huge = rollout(today(), CHILD);
    await put(huge, 'x'.repeat(8 * 1024 * 1024 + 1));
    expect(adapter.classify(source, huge)).toBeNull();
  });

  it('is busy, and updated, while only a sub-agent is writing', async () => {
    const parent = rollout(day('2026', '01', '01'), PARENT);
    const child = rollout(day('2026', '01', '01'), CHILD);
    await put(parent, meta(PARENT));
    await put(child, meta(CHILD, { parent_thread_id: PARENT }));
    const old = new Date(Date.now() - 60_000);
    await utimes(parent, old, old);
    const adapter = createCodexAdapter({ codexDir });
    const [source] = await adapter.discover();
    expect(source?.summary.live).toBe('busy');
    expect(Date.parse(source?.summary.updatedAt ?? '')).toBeGreaterThan(old.getTime() + 30_000);
    expect(await adapter.liveStatus()).toEqual(new Map([[PARENT, 'busy']]));
  });

  it('does not decompress an unchanged archive on every scan', async () => {
    let calls = 0;
    const io = {
      decompress: (buf: Buffer) => {
        calls += 1;
        return zstdDecompressSync(buf);
      },
    };
    const archive = join(
      codexDir,
      'archived_sessions',
      `rollout-2026-01-01T00-00-00-${OTHER}.jsonl.zst`,
    );
    await put(archive, zstdCompressSync(Buffer.from(meta(OTHER))));
    const adapter = createCodexAdapter({ codexDir }, io);
    await adapter.discover();
    await adapter.discover();
    expect(calls).toBe(1);
    await put(archive, zstdCompressSync(Buffer.from(meta(OTHER, { cwd: '/work/moved' }))));
    const later = new Date(Date.now() + 5_000);
    await utimes(archive, later, later);
    expect((await adapter.discover())[0]?.summary.cwd).toBe('/work/moved');
    expect(calls).toBe(2);
  });
});

describe('reading headers', () => {
  it('a header longer than the first read, and a file with no newline yet, both resolve', async () => {
    const long = join(
      codexDir,
      'sessions',
      '2026',
      '01',
      '01',
      `rollout-2026-01-01T00-00-00-${PARENT}.jsonl`,
    );
    await put(long, meta(PARENT, { base_instructions: { text: 'x'.repeat(300_000) } }));
    const torn = join(
      codexDir,
      'sessions',
      '2026',
      '01',
      '01',
      `rollout-2026-01-01T00-00-01-${OTHER}.jsonl`,
    );
    await put(torn, meta(OTHER).trimEnd().slice(0, 40));
    const sources = await createCodexAdapter({ codexDir }).discover();
    expect(sources.find((s) => s.nativeId === PARENT)?.summary.cwd).toBe(CWD);
    // Unfinished header: listed by its filename id, details unknown until it is written.
    expect(sources.find((s) => s.nativeId === OTHER)?.summary.cwd).toBeNull();
  });
});

describe('archives during a live session', () => {
  it('an archive is claimed only once its plain rollout is gone, and listed without a rescan', async () => {
    const dir = join(codexDir, 'sessions', '2026', '01', '01');
    const plain = join(dir, `rollout-2026-01-01T00-00-00-${PARENT}.jsonl`);
    const child = join(dir, `rollout-2026-01-01T00-00-01-${CHILD}.jsonl`);
    const header = meta(CHILD, { parent_thread_id: PARENT });
    await put(plain, meta(PARENT));
    await put(child, header);
    const adapter = createCodexAdapter({ codexDir });
    const [source] = await adapter.discover();
    if (!source) throw new Error('no session');
    // Codex compresses the finished child: same records, new path.
    await put(`${child}.zst`, zstdCompressSync(Buffer.from(header)));
    // The plain file still holds them, and is the one listed.
    expect(adapter.classify(source, `${child}.zst`)).toBeNull();
    await rm(child);
    // Claimed so the server reads the session again; listFiles then has the archive.
    expect(adapter.classify(source, `${child}.zst`)).toMatchObject({
      role: 'subagent',
      agentId: CHILD,
      encoded: true,
    });
    expect((await adapter.listFiles(source)).map((f) => f.path).sort()).toEqual(
      [plain, `${child}.zst`].sort(),
    );
    // Someone else's archive stays theirs.
    await put(
      join(dir, `rollout-2026-01-01T00-00-02-${OTHER}.jsonl.zst`),
      zstdCompressSync(Buffer.from(meta(OTHER))),
    );
    expect(
      adapter.classify(source, join(dir, `rollout-2026-01-01T00-00-02-${OTHER}.jsonl.zst`)),
    ).toBeNull();
  });
});

describe('encoded archives', () => {
  const archive = () =>
    join(codexDir, 'archived_sessions', `rollout-2026-01-01T00-00-00-${PARENT}.jsonl.zst`);
  const text = () =>
    `${meta(PARENT)}${line('event_msg', 1, 1, { type: 'task_started', turn_id: 't1' })}\n`;

  it('lists an archive as encoded and a plain rollout as not', async () => {
    await put(archive(), zstdCompressSync(Buffer.from(text())));
    await put(
      join(codexDir, 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${OTHER}.jsonl`),
      meta(OTHER),
    );
    const adapter = createCodexAdapter({ codexDir });
    const files = (
      await Promise.all((await adapter.discover()).map((s) => adapter.listFiles(s)))
    ).flat();
    expect(files.map((f) => [f.path.endsWith('.zst'), f.encoded ?? false]).sort()).toEqual([
      [false, false],
      [true, true],
    ]);
  });

  it('readFile returns the decoded text, decompressing off the event loop', async () => {
    await put(archive(), zstdCompressSync(Buffer.from(text())));
    const adapter = createCodexAdapter({ codexDir });
    const [source] = await adapter.discover();
    if (!source) throw new Error('no session');
    const [file] = await adapter.listFiles(source);
    if (!file) throw new Error('no file');
    expect(await adapter.readFile?.(file)).toBe(text());
    // The default decompressor is the async zlib one, so a big archive never blocks the loop.
    expect(resolveDecompress()?.(zstdCompressSync(Buffer.from('x')))).toBeInstanceOf(Promise);
  });

  it('readFile rejects when the archive cannot be decoded', async () => {
    await put(archive(), zstdCompressSync(Buffer.from(text())));
    const adapter = createCodexAdapter({ codexDir });
    const [source] = await adapter.discover();
    if (!source) throw new Error('no session');
    const [file] = await adapter.listFiles(source);
    if (!file) throw new Error('no file');
    await put(archive(), deflateSync(Buffer.from(text())));
    await expect(adapter.readFile?.(file)).rejects.toThrow();
    const noZstd = createCodexAdapter({ codexDir }, { decompress: undefined });
    await expect(noZstd.readFile?.(file)).rejects.toThrow();
  });
});

describe('a rollout and its archive at the same moment', () => {
  it('lists the plain rollout while it exists, else the archive, never both', async () => {
    const dir = join(codexDir, 'sessions', '2026', '01', '01');
    const main = join(dir, `rollout-2026-01-01T00-00-00-${PARENT}.jsonl`);
    const child = join(dir, `rollout-2026-01-01T00-00-01-${CHILD}.jsonl`);
    const header = meta(CHILD, { parent_thread_id: PARENT });
    await put(main, meta(PARENT));
    await put(child, header);
    // Codex writes the archive after the plain file: it is the newer one.
    await put(`${child}.zst`, zstdCompressSync(Buffer.from(header)));
    const older = new Date(Date.now() - 10_000);
    await utimes(child, older, older);
    const adapter = createCodexAdapter({ codexDir });
    const listed = async () => {
      const [source] = await adapter.discover();
      if (!source) throw new Error('no session');
      return (await adapter.listFiles(source)).map((f) => f.path).sort();
    };
    expect(await listed()).toEqual([main, child].sort());
    await rm(child);
    expect(await listed()).toEqual([main, `${child}.zst`].sort());
  });
});

describe('a Codex home reached through a symlink', () => {
  let linkDir: string;
  beforeEach(async () => {
    linkDir = await realpath(await mkdtemp(join(tmpdir(), 'glassbox-codex-link-')));
  });
  afterEach(async () => {
    await rm(linkDir, { recursive: true, force: true });
  });

  const two = (n: number) => String(n).padStart(2, '0');
  const today = (root: string) => {
    const n = new Date();
    return join(root, 'sessions', String(n.getFullYear()), two(n.getMonth() + 1), two(n.getDate()));
  };

  it('watches real folders, and claims a rollout under its real name only', async () => {
    const home = join(linkDir, 'codex');
    await symlink(codexDir, home);
    const name = `rollout-2026-01-01T00-00-00-${PARENT}.jsonl`;
    await put(join(today(codexDir), name), meta(PARENT));
    const adapter = createCodexAdapter({ codexDir: home });
    const [source] = await adapter.discover();
    if (!source) throw new Error('no session');
    const dirs = adapter.watchDirs(source);
    expect(dirs).toContain(today(codexDir));
    expect(dirs.filter((d) => d.startsWith(home))).toEqual([]);
    // The same bytes under a second name would be read twice.
    expect(adapter.classify(source, join(today(home), name))).toBeNull();
    expect(adapter.classify(source, join(today(codexDir), name))).toMatchObject({
      role: 'rollout',
    });
  });

  it('does not follow a rollout-named link, to a credential file or elsewhere', async () => {
    await put(join(day(), `rollout-2026-01-01T00-00-00-${PARENT}.jsonl`), meta(PARENT));
    const adapter = createCodexAdapter({ codexDir });
    const [source] = await adapter.discover();
    if (!source) throw new Error('no session');
    const child = meta(CHILD, { parent_thread_id: PARENT });
    const secret = join(linkDir, 'auth.json');
    const elsewhere = join(linkDir, 'notes.jsonl');
    await put(secret, child);
    await put(elsewhere, child);
    const toSecret = join(today(codexDir), `rollout-2026-01-01T00-00-01-${CHILD}.jsonl`);
    const toElsewhere = join(today(codexDir), `rollout-2026-01-01T00-00-02-${CHILD}.jsonl`);
    await mkdir(today(codexDir), { recursive: true });
    await symlink(secret, toSecret);
    await symlink(elsewhere, toElsewhere);
    expect(adapter.classify(source, toSecret)).toBeNull();
    expect(adapter.classify(source, toElsewhere)).toBeNull();
  });

  it('turns down a rollout-named FIFO without waiting for a writer', async () => {
    await put(join(day(), `rollout-2026-01-01T00-00-00-${PARENT}.jsonl`), meta(PARENT));
    const adapter = createCodexAdapter({ codexDir });
    const [source] = await adapter.discover();
    if (!source) throw new Error('no session');
    const fifo = join(today(codexDir), `rollout-2026-01-01T00-00-01-${CHILD}.jsonl`);
    await mkdir(today(codexDir), { recursive: true });
    execFileSync('mkfifo', [fifo]);
    // A blocking open would hang here, and with it the server's event loop.
    expect(adapter.classify(source, fifo)).toBeNull();
  });

  function day() {
    return join(codexDir, 'sessions', '2026', '01', '01');
  }
});
