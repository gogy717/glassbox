import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchDirs } from './watch.js';

/** fs.watch handles that were opened and not closed yet. */
const open = vi.hoisted(() => new Set<object>());
/** Paths whose next fs.watch fails as if the dir did not exist yet. */
const failOnce = vi.hoisted(() => new Set<string>());

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const watch = ((...args: Parameters<typeof fs.watch>) => {
    const path = String(args[0]);
    if (failOnce.delete(path))
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    const w = fs.watch(...args);
    open.add(w);
    const close = w.close.bind(w);
    w.close = () => {
      open.delete(w);
      close();
    };
    return w;
  }) as typeof fs.watch;
  return { ...fs, watch };
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassbox-watch-'));
  open.clear();
  failOnce.clear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Let pending readdir/stat callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 100));

describe('watchDirs watcher lifecycle', () => {
  it('leaves no fs.watch handle behind when closed while a new dir is being scanned', async () => {
    const wf = join(dir, 'wf_1');
    mkdirSync(wf);
    failOnce.add(wf); // not watchable when added, so the scan will try again…
    const w = watchDirs([], () => {}, { pollMs: 60_000 });
    w.setDirs([wf]);
    w.close(); // …after this
    await settle();
    expect(open.size).toBe(0);
  });

  it('leaves no fs.watch handle behind for a dir dropped while it was being scanned', async () => {
    const wf = join(dir, 'wf_2');
    mkdirSync(wf);
    failOnce.add(wf);
    const w = watchDirs([], () => {}, { pollMs: 60_000 });
    w.setDirs([wf]);
    w.setDirs([]);
    await settle();
    expect(open.size).toBe(0);
    w.close();
  });

  it('closes every handle it opened', async () => {
    const a = join(dir, 'a');
    mkdirSync(a);
    const w = watchDirs([a, dir], () => {}, { pollMs: 60_000 });
    expect(open.size).toBe(2);
    w.close();
    expect(open.size).toBe(0);
  });
});
