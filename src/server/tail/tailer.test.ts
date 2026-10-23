import { appendFile, mkdir, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonlTailer, readJsonFile } from './tailer.js';
import { watchDirs } from './watch.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassbox-tail-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('JsonlTailer', () => {
  it('returns only the lines appended since the previous read', async () => {
    const file = join(dir, 'a.jsonl');
    await writeFile(file, '{"n":1}\n{"n":2}\n');
    const t = new JsonlTailer(file);

    expect(await t.read()).toEqual({ lines: ['{"n":1}', '{"n":2}'], reset: false, more: false });
    await appendFile(file, '{"n":3}\n');
    expect(await t.read()).toEqual({ lines: ['{"n":3}'], reset: false, more: false });
    expect(await t.read()).toEqual({ lines: [], reset: false, more: false });
  });

  it('holds back a half-written line until its newline arrives, then delivers it once', async () => {
    const file = join(dir, 'a.jsonl');
    await writeFile(file, '{"n":1}\n{"n":');
    const t = new JsonlTailer(file);

    expect((await t.read()).lines).toEqual(['{"n":1}']);
    expect((await t.read()).lines).toEqual([]);
    await appendFile(file, '2}\n');
    expect((await t.read()).lines).toEqual(['{"n":2}']);
    expect((await t.read()).lines).toEqual([]);
  });

  it('starts over from offset 0 when the file shrinks', async () => {
    const file = join(dir, 'a.jsonl');
    await writeFile(file, '{"n":1}\n{"n":2}\n');
    const t = new JsonlTailer(file);
    await t.read();

    await truncate(file, 0);
    await appendFile(file, '{"m":1}\n');
    expect(await t.read()).toEqual({ lines: ['{"m":1}'], reset: true, more: false });
    expect(await t.read()).toEqual({ lines: [], reset: false, more: false });
  });

  it('starts over when the file is replaced by a larger one via rename', async () => {
    const file = join(dir, 'a.jsonl');
    await writeFile(file, '{"n":1}\n');
    const t = new JsonlTailer(file);
    await t.read();

    const tmp = join(dir, 'a.jsonl.tmp');
    await writeFile(tmp, '{"m":1}\n{"m":2}\n{"m":3}\n');
    await rename(tmp, file);
    expect(await t.read()).toEqual({
      lines: ['{"m":1}', '{"m":2}', '{"m":3}'],
      reset: true,
      more: false,
    });
  });

  it('drops a pending half line when the file is replaced', async () => {
    const file = join(dir, 'a.jsonl');
    await writeFile(file, '{"n":1}\n{"stale":');
    const t = new JsonlTailer(file);
    await t.read();

    const tmp = join(dir, 'a.jsonl.tmp');
    await writeFile(tmp, '{"m":1}\n{"m":2}\n{"m":3}\n');
    await rename(tmp, file);
    expect((await t.read()).lines).toEqual(['{"m":1}', '{"m":2}', '{"m":3}']);
  });

  it('strips CR from CRLF line endings and skips blank lines', async () => {
    const file = join(dir, 'a.jsonl');
    await writeFile(file, '{"n":1}\r\n\r\n{"n":2}\r\n\n');
    const t = new JsonlTailer(file);
    expect((await t.read()).lines).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('reads a missing file as empty (not gone) and picks it up once it exists', async () => {
    const file = join(dir, 'later.jsonl');
    const t = new JsonlTailer(file);
    expect(await t.read()).toEqual({ lines: [], reset: false, more: false });

    await writeFile(file, '{"n":1}\n');
    expect(await t.read()).toEqual({ lines: ['{"n":1}'], reset: false, more: false });
  });

  it('resets when a file that was read is deleted and written again', async () => {
    const file = join(dir, 'a.jsonl');
    await writeFile(file, '{"n":1}\n{"n":2}\n');
    const t = new JsonlTailer(file);
    await t.read();

    await rm(file);
    // Gone: what was read from it may no longer be true (e.g. it was archived elsewhere).
    expect(await t.read()).toEqual({ lines: [], reset: false, more: false, gone: true });
    await writeFile(file, '{"m":1}\n{"m":2}\n{"m":3}\n');
    expect(await t.read()).toEqual({
      lines: ['{"m":1}', '{"m":2}', '{"m":3}'],
      reset: true,
      more: false,
    });
  });

  it('reads at most maxBytes per call and reports whether more remains', async () => {
    const file = join(dir, 'a.jsonl');
    // Multi-byte characters straddle the 5-byte chunk boundaries.
    await writeFile(file, '"héllo"\n"wörld"\n"✓"\n');
    const t = new JsonlTailer(file);

    const lines: string[] = [];
    let calls = 0;
    for (;;) {
      const r = await t.read(5);
      calls++;
      lines.push(...r.lines);
      if (!r.more) break;
    }
    expect(lines).toEqual(['"héllo"', '"wörld"', '"✓"']);
    // 24 bytes in 5-byte chunks.
    expect(calls).toBe(5);
  });
});

describe('readJsonFile', () => {
  it('parses a json file', async () => {
    const file = join(dir, 'a.json');
    await writeFile(file, '{"agentType":"Explore"}');
    expect(await readJsonFile(file)).toEqual({
      text: '{"agentType":"Explore"}',
      value: { agentType: 'Explore' },
    });
  });

  it('returns undefined for a missing file', async () => {
    expect(await readJsonFile(join(dir, 'nope.json'))).toBeUndefined();
  });

  it('returns undefined for a half-written file', async () => {
    const file = join(dir, 'a.json');
    await writeFile(file, '{"agentType":"Expl');
    expect(await readJsonFile(file)).toBeUndefined();
  });
});

describe('watchDirs', () => {
  const collect = () => {
    const seen: string[] = [];
    return { seen, onChange: (p: string) => seen.push(p) };
  };

  it('reports a new file through the poll fallback', async () => {
    const { seen, onChange } = collect();
    const w = watchDirs([dir], onChange, { pollMs: 20, fsWatch: false });
    try {
      const file = join(dir, 'agent-1.jsonl');
      await writeFile(file, '{}\n');
      await vi.waitFor(() => expect(seen).toContain(file), { timeout: 2000 });
    } finally {
      w.close();
    }
  });

  it('reports an appended file through the poll fallback', async () => {
    const file = join(dir, 'main.jsonl');
    await writeFile(file, '{}\n');
    const { seen, onChange } = collect();
    const w = watchDirs([dir], onChange, { pollMs: 20, fsWatch: false });
    try {
      await sleep(80);
      expect(seen).toEqual([]);
      await appendFile(file, '{"more":true}\n');
      await vi.waitFor(() => expect(seen).toContain(file), { timeout: 2000 });
    } finally {
      w.close();
    }
  });

  it('reports a new file through fs.watch without waiting for a poll', async () => {
    const { seen, onChange } = collect();
    const w = watchDirs([dir], onChange, { pollMs: 60_000 });
    try {
      // fs.watch (FSEvents on macOS) goes live asynchronously; a write before that is only
      // caught by the poll. Touch a sentinel until fs.watch reports it, then test a new file.
      const sentinel = join(dir, 'sentinel');
      await vi.waitFor(
        async () => {
          await writeFile(sentinel, String(Math.random()));
          expect(seen).toContain(sentinel);
        },
        { timeout: 5000, interval: 50 },
      );
      const file = join(dir, 'agent-2.jsonl');
      await writeFile(file, '{}\n');
      await vi.waitFor(() => expect(seen).toContain(file), { timeout: 2000 });
    } finally {
      w.close();
    }
  });

  it('reports every file of a directory that only appears later', async () => {
    const wf = join(dir, 'wf_1');
    const { seen, onChange } = collect();
    const w = watchDirs([wf], onChange, { pollMs: 20, fsWatch: false });
    try {
      await sleep(60);
      await mkdir(wf);
      await writeFile(join(wf, 'journal.jsonl'), '{}\n');
      await vi.waitFor(() => expect(seen).toContain(join(wf, 'journal.jsonl')), {
        timeout: 2000,
      });
    } finally {
      w.close();
    }
  });

  it('reports the files already inside a directory added with setDirs', async () => {
    const wf = join(dir, 'wf_2');
    await mkdir(wf);
    await writeFile(join(wf, 'agent-a.jsonl'), '{}\n');
    const { seen, onChange } = collect();
    const w = watchDirs([dir], onChange, { pollMs: 60_000, fsWatch: false });
    try {
      w.setDirs([dir, wf]);
      await vi.waitFor(() => expect(seen).toContain(join(wf, 'agent-a.jsonl')), {
        timeout: 2000,
      });
    } finally {
      w.close();
    }
  });

  it('stops reporting after close', async () => {
    const { seen, onChange } = collect();
    const w = watchDirs([dir], onChange, { pollMs: 20 });
    w.close();
    await writeFile(join(dir, 'late.jsonl'), '{}\n');
    await sleep(120);
    expect(seen).toEqual([]);
  });
});
