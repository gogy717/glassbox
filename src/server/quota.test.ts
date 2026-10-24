import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../core/adapter.js';
import { createDemoQuota } from '../core/fixtures/demo.js';
import type { QuotaSnapshot, QuotaStaleReason } from '../core/model.js';
import type { QuotaSource } from '../core/quota-source.js';
import { createFakeAdapter } from './__tests__/fake-adapter.js';
import { adapterQuotaSources, mergeQuotas, QuotaWatcher } from './quota.js';

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

async function startSources(
  sources: QuotaSource[],
  opts: { pollMs?: number; readTimeoutMs?: number; log?: (msg: string) => void } = {},
) {
  watcher = new QuotaWatcher({ sources, debounceMs: 20, log: () => {}, ...opts });
  await watcher.start();
  return watcher;
}

const startWatcher = (adapters: AgentAdapter[], opts: { pollMs?: number } = {}) =>
  startSources(adapterQuotaSources(adapters), opts);

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
      sources: adapterQuotaSources([fake]),
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
      sources: adapterQuotaSources([broken, createFakeAdapter(root, { quota: true })]),
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

/** A snapshot of `provider` fetched at `fetchedAt`, tagged with the source that reported it. */
const snap = (provider: string, fetchedAt: string, source = 'test'): QuotaSnapshot => ({
  ...quotaAt(10),
  provider,
  fetchedAt,
  source,
});
const T1 = '2026-10-23T01:00:00.000Z';
const T2 = '2026-10-23T02:00:00.000Z';

/** A source whose successive reads return the scripted values (the last repeats). */
function scriptedSource(id: string, values: QuotaSnapshot[][]): QuotaSource & { reads: number } {
  const source = {
    id,
    reads: 0,
    read: async () => values[Math.min(source.reads++, values.length - 1)] ?? [],
  };
  return source;
}

describe('mergeQuotas', () => {
  it('keeps the newest snapshot per provider, and the earlier one on a tie', () => {
    expect(
      mergeQuotas([
        snap('anthropic', T1, 'claude-code-cache'),
        snap('anthropic', T2, 'anthropic-usage-api'),
        snap('openai', T2, 'oh-my-pi-cache'),
        snap('openai', T2, 'codex-session'),
      ]),
    ).toEqual([snap('anthropic', T2, 'anthropic-usage-api'), snap('openai', T2, 'oh-my-pi-cache')]);
  });

  it('compares times, not strings, and treats an unreadable one as the oldest', () => {
    const offset = snap('anthropic', '2026-10-23T02:00:00.290185+00:00', 'claude-code-cache');
    const zulu = snap('anthropic', '2026-10-23T01:59:59.000Z', 'anthropic-usage-api');
    expect(mergeQuotas([zulu, offset])).toEqual([offset]);
    expect(mergeQuotas([offset, zulu])).toEqual([offset]);
    const broken = snap('xai', 'not a time', 'broken');
    expect(mergeQuotas([broken, snap('xai', T1)])).toEqual([snap('xai', T1)]);
  });

  it('orders anthropic, openai, xai, github-copilot, deepseek, then the others by id', () => {
    const providers = [
      'zai',
      'deepseek',
      'github-copilot',
      'moonshot',
      'xai',
      'openai',
      'anthropic',
    ];
    expect(mergeQuotas(providers.map((p) => snap(p, T1))).map((q) => q.provider)).toEqual([
      'anthropic',
      'openai',
      'xai',
      'github-copilot',
      'deepseek',
      'moonshot',
      'zai',
    ]);
  });
});

describe('QuotaWatcher with several sources', () => {
  it('merges every source per provider', async () => {
    const w = await startSources([
      scriptedSource('cache', [[snap('anthropic', T1, 'claude-code-cache'), snap('xai', T1)]]),
      scriptedSource('omp', [[snap('openai', T1), snap('anthropic', T2, 'anthropic-usage-api')]]),
    ]);
    expect(w.current()).toEqual([
      snap('anthropic', T2, 'anthropic-usage-api'),
      snap('openai', T1),
      snap('xai', T1),
    ]);
  });

  it('reads the sources concurrently, merging them in list order', async () => {
    // The first source answers only once the second has been asked: read one after the other,
    // they would never finish. Both report anthropic at the same time, so the first one wins.
    let releaseFirst: () => void = () => {};
    const first: QuotaSource = {
      id: 'slow',
      read: () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve([snap('anthropic', T1, 'claude-code-cache'), snap('xai', T1)]);
        }),
    };
    const second: QuotaSource = {
      id: 'fast',
      read: async () => {
        releaseFirst();
        return [snap('anthropic', T1, 'anthropic-usage-api'), snap('openai', T1)];
      },
    };
    const w = await startSources([first, second]);
    expect(w.current()).toEqual([
      snap('anthropic', T1, 'claude-code-cache'),
      snap('openai', T1),
      snap('xai', T1),
    ]);
  });

  it('does not hold up start() or the other sources for a source that never answers', async () => {
    const logs: string[] = [];
    const hung: QuotaSource = { id: 'hung', read: () => new Promise(() => {}) };
    const ok = scriptedSource('ok', [[snap('openai', T1)], [snap('openai', T2)]]);
    const started = Date.now();
    const w = await startSources([hung, ok], {
      pollMs: 30,
      readTimeoutMs: 100,
      log: (m) => logs.push(m),
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(w.current()).toEqual([snap('openai', T1)]);
    await vi.waitFor(() => expect(w.current()).toEqual([snap('openai', T2)]), { timeout: 2000 });
    // Every read of the hung source times out; that counts as one failure streak.
    await sleep(300);
    expect(logs).toEqual(['quota (hung): no answer within 0.1s']);
  });

  it('publishes each source as soon as it answers, without waiting for a slow one', async () => {
    // The slow source answers its first read at once; later reads wait until released.
    let reads = 0;
    let release: (q: QuotaSnapshot[]) => void = () => {};
    const slow: QuotaSource = {
      id: 'slow',
      read: async () =>
        reads++ === 0 ? [snap('xai', T1)] : new Promise((resolve) => (release = resolve)),
    };
    const fast = scriptedSource('fast', [[snap('anthropic', T1)], [snap('anthropic', T2)]]);
    const w = await startSources([slow, fast], { pollMs: 30, readTimeoutMs: 10_000 });
    expect(w.current()).toEqual([snap('anthropic', T1), snap('xai', T1)]);

    await vi.waitFor(() => expect(w.current()[0]).toEqual(snap('anthropic', T2)), {
      timeout: 2000,
    });
    expect(reads).toBe(2);
    release([snap('xai', T2)]);
    await vi.waitFor(() => expect(w.current()).toEqual([snap('anthropic', T2), snap('xai', T2)]), {
      timeout: 2000,
    });
  });

  it('cuts every pending confirmation short on stop', async () => {
    vi.useFakeTimers();
    try {
      const sources = [
        scriptedSource('a', [[snap('openai', T1)], []]),
        scriptedSource('b', [[snap('xai', T1)], []]),
      ];
      watcher = new QuotaWatcher({ sources, pollMs: 1000, debounceMs: 60_000, log: () => {} });
      await watcher.start();
      // The poll finds both providers gone: each source waits to read again and confirm.
      await vi.advanceTimersByTimeAsync(1000);
      expect(sources.map((s) => s.reads)).toEqual([2, 2]);
      expect(vi.getTimerCount()).toBe(3);

      watcher.stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(sources.map((s) => s.reads)).toEqual([2, 2]);
      expect(watcher.current()).toEqual([snap('openai', T1), snap('xai', T1)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the other sources when one fails, and logs the failure once per streak', async () => {
    const logs: string[] = [];
    let fail = true;
    const flaky: QuotaSource = {
      id: 'flaky',
      read: async () => {
        if (fail) throw new Error('database is locked');
        return [snap('xai', T1)];
      },
    };
    const w = await startSources([flaky, scriptedSource('ok', [[snap('openai', T1)]])], {
      pollMs: 20,
      log: (m) => logs.push(m),
    });
    expect(w.current()).toEqual([snap('openai', T1)]);
    await sleep(100);
    expect(logs).toEqual(['quota (flaky): database is locked']);

    fail = false;
    await vi.waitFor(() => expect(w.current()).toEqual([snap('openai', T1), snap('xai', T1)]), {
      timeout: 2000,
    });
  });

  it('does not drop a provider one source briefly stops reporting', async () => {
    const both = [snap('openai', T1), snap('xai', T1)];
    const w = await startSources([scriptedSource('omp', [both, [snap('openai', T1)], both])], {
      pollMs: 30,
    });
    const seen: QuotaSnapshot[][] = [];
    w.onChange((q) => seen.push(q));

    await sleep(300);
    expect(seen).toEqual([]);
    expect(w.current()).toEqual(both);
  });

  it('drops a provider once a second read of its source confirms it is gone', async () => {
    const source = scriptedSource('omp', [
      [snap('openai', T1), snap('xai', T1)],
      [snap('openai', T1)],
    ]);
    const w = await startSources([source], { pollMs: 30 });
    const seen: QuotaSnapshot[][] = [];
    w.onChange((q) => seen.push(q));

    await vi.waitFor(() => expect(seen).toEqual([[snap('openai', T1)]]), { timeout: 2000 });
  });

  it('says why each stale quota is stale, as of the latest read', async () => {
    const stale = (provider: string) => ({ ...snap(provider, T1), stale: true });
    let xaiReason: QuotaStaleReason | undefined = 'sign-in-expired';
    const w = new QuotaWatcher({
      sources: [scriptedSource('cache', [[snap('anthropic', T2), stale('xai'), stale('openai')]])],
      pollMs: 30,
      staleReason: (q) => (q.provider === 'xai' ? xaiReason : 'cache-only'),
    });
    watcher = w;
    await w.start();
    expect(w.current()).toEqual([
      snap('anthropic', T2),
      { ...stale('openai'), staleReason: 'cache-only' },
      { ...stale('xai'), staleReason: 'sign-in-expired' },
    ]);
    xaiReason = undefined;
    await vi.waitFor(() => expect(w.current()[2]).toEqual(stale('xai')), { timeout: 2000 });
  });

  it('shows the older snapshot of a provider when the newer source loses it', async () => {
    const w = await startSources(
      [
        scriptedSource('cache', [[snap('anthropic', T1, 'claude-code-cache')]]),
        scriptedSource('api', [[snap('anthropic', T2, 'anthropic-usage-api')], []]),
      ],
      { pollMs: 30 },
    );
    expect(w.current()).toEqual([snap('anthropic', T2, 'anthropic-usage-api')]);
    await vi.waitFor(
      () => expect(w.current()).toEqual([snap('anthropic', T1, 'claude-code-cache')]),
      {
        timeout: 2000,
      },
    );
  });
});
