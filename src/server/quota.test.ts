import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../core/adapter.js';
import { createDemoQuota } from '../core/fixtures/demo.js';
import type { QuotaSnapshot } from '../core/model.js';
import { createFakeAdapter } from './__tests__/fake-adapter.js';
import { QuotaWatcher } from './quota.js';

let root: string;
let watcher: QuotaWatcher | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'glassbox-quota-'));
});

afterEach(async () => {
  watcher?.stop();
  watcher = undefined;
  await rm(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quotaAt = (usedPercent: number): QuotaSnapshot => {
  const q = createDemoQuota(new Date('2026-10-23T02:00:00.000Z'));
  return { ...q, windows: q.windows.map((w) => ({ ...w, usedPercent })) };
};
// Atomic, like most config writers; a reader catching a half-written file is tested separately.
const writeQuota = async (q: QuotaSnapshot) => {
  await writeFile(join(root, 'quota.json.tmp'), JSON.stringify(q));
  await rename(join(root, 'quota.json.tmp'), join(root, 'quota.json'));
};

async function startWatcher(adapters: AgentAdapter[], opts: { pollMs?: number } = {}) {
  watcher = new QuotaWatcher({ adapters, debounceMs: 20, log: () => {}, ...opts });
  await watcher.start();
  return watcher;
}

describe('QuotaWatcher', () => {
  it('reports no quota for adapters without quota support', async () => {
    const w = await startWatcher([createFakeAdapter(root)]);
    expect(w.current()).toEqual([]);
  });

  it('reports no quota when the adapter has none cached', async () => {
    const w = await startWatcher([createFakeAdapter(root, { quota: true })]);
    expect(w.current()).toEqual([]);
  });

  it('reads the quota at start', async () => {
    await writeQuota(quotaAt(62));
    const w = await startWatcher([createFakeAdapter(root, { quota: true })]);
    expect(w.current()).toEqual([quotaAt(62)]);
  });

  it('emits when a quota file changes, and only when the quota itself changed', async () => {
    await writeQuota(quotaAt(62));
    const fake = createFakeAdapter(root, { quota: true });
    const w = await startWatcher([fake], { pollMs: 60_000 });
    const seen: QuotaSnapshot[][] = [];
    w.onChange((q) => seen.push(q));

    // fs.watch goes live asynchronously (see tailer.test.ts): repeat the write until seen.
    await vi.waitFor(
      async () => {
        await writeQuota(quotaAt(70));
        expect(seen).toHaveLength(1);
      },
      { timeout: 5000, interval: 50 },
    );
    expect(seen).toEqual([[quotaAt(70)]]);

    // Rewritten with identical content: read again, but nothing to report.
    const reads = fake.quotaReads;
    await writeQuota(quotaAt(70));
    await vi.waitFor(() => expect(fake.quotaReads).toBeGreaterThan(reads), { timeout: 3000 });
    await sleep(100);
    expect(seen).toHaveLength(1);
    expect(w.current()).toEqual([quotaAt(70)]);
  });

  it('re-reads on a timer, so a quota that only ages (stale) still updates', async () => {
    let stale = false;
    const adapter: AgentAdapter = {
      ...createFakeAdapter(root),
      quotaFiles: () => [],
      quota: async () => ({ ...quotaAt(10), stale }),
    };
    const w = await startWatcher([adapter], { pollMs: 30 });
    const seen: QuotaSnapshot[][] = [];
    w.onChange((q) => seen.push(q));

    stale = true;
    await vi.waitFor(() => expect(seen.at(-1)?.[0]?.stale).toBe(true), { timeout: 2000 });
  });

  it('reads at most once per debounce window while the file keeps changing', async () => {
    await writeQuota(quotaAt(1));
    const fake = createFakeAdapter(root, { quota: true });
    watcher = new QuotaWatcher({
      adapters: [fake],
      debounceMs: 600,
      pollMs: 60_000,
      log: () => {},
    });
    await watcher.start();
    // Rewrite identical content until fs.watch demonstrably triggers a read.
    const started = fake.quotaReads;
    await vi.waitFor(
      async () => {
        await writeQuota(quotaAt(1));
        expect(fake.quotaReads).toBeGreaterThan(started);
      },
      { timeout: 5000, interval: 700 },
    );
    await sleep(700);
    const before = fake.quotaReads;

    // Writes further apart than one read takes, all inside one debounce window.
    for (let i = 2; i <= 7; i++) {
      await writeQuota(quotaAt(i));
      await sleep(60);
    }
    await vi.waitFor(() => expect(watcher?.current()[0]?.windows[0]?.usedPercent).toBe(7), {
      timeout: 3000,
    });
    expect(fake.quotaReads - before).toBeLessThanOrEqual(2);
  });

  it('treats a failing adapter as having no quota and keeps the others', async () => {
    await writeQuota(quotaAt(5));
    const logs: string[] = [];
    const broken: AgentAdapter = {
      ...createFakeAdapter(root),
      kind: 'broken',
      quotaFiles: () => [],
      quota: async () => {
        throw new Error('bad cache');
      },
    };
    watcher = new QuotaWatcher({
      adapters: [broken, createFakeAdapter(root, { quota: true })],
      log: (m) => logs.push(m),
    });
    await watcher.start();
    expect(watcher.current()).toEqual([quotaAt(5)]);
    expect(logs.some((m) => m.includes('bad cache'))).toBe(true);
  });

  it('stops watching and notifying after stop', async () => {
    await writeQuota(quotaAt(1));
    const w = await startWatcher([createFakeAdapter(root, { quota: true })], { pollMs: 30 });
    const seen: QuotaSnapshot[][] = [];
    w.onChange((q) => seen.push(q));
    w.stop();

    await writeQuota(quotaAt(2));
    await sleep(200);
    expect(seen).toEqual([]);
  });
});

describe('QuotaWatcher with a quota that briefly reads as missing', () => {
  /** An adapter whose successive quota() calls return the scripted values (the last repeats). */
  function scripted(values: (QuotaSnapshot | null)[]): AgentAdapter {
    let i = 0;
    return {
      ...createFakeAdapter(root),
      quotaFiles: () => [],
      quota: async () => values[Math.min(i++, values.length - 1)] ?? null,
    };
  }

  it('does not announce a quota as gone when the next read finds it again', async () => {
    // A config file caught mid-rewrite parses as nothing; the following read is fine.
    const w = await startWatcher([scripted([quotaAt(5), null, quotaAt(5)])], { pollMs: 30 });
    const seen: QuotaSnapshot[][] = [];
    w.onChange((q) => seen.push(q));

    await sleep(300);
    expect(seen).toEqual([]);
    expect(w.current()).toEqual([quotaAt(5)]);
  });

  it('announces a quota as gone once a second read confirms it', async () => {
    const w = await startWatcher([scripted([quotaAt(5), null])], { pollMs: 30 });
    const seen: QuotaSnapshot[][] = [];
    w.onChange((q) => seen.push(q));

    await vi.waitFor(() => expect(seen).toEqual([[]]), { timeout: 2000 });
  });
});
