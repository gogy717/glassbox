import { dirname } from 'node:path';
import type { AgentAdapter } from '../core/adapter.js';
import type { QuotaProvider, QuotaSnapshot } from '../core/model.js';
import type { QuotaSource } from '../core/quota-source.js';
import { errorText } from './open-session.js';
import { type DirWatcher, watchDirs } from './tail/watch.js';

export interface QuotaWatcherOptions {
  sources: QuotaSource[];
  /** Re-read interval: a quota also turns `stale` with age, without any file changing. */
  pollMs?: number;
  /** After a file change, wait this long and read once; the agent rewrites its config often. */
  debounceMs?: number;
  log?: (msg: string) => void;
}

/** The quota sources of adapters that report one; the source id is the agent kind. */
export function adapterQuotaSources(adapters: AgentAdapter[]): QuotaSource[] {
  return adapters.flatMap((a) => {
    const { quota, quotaFiles } = a;
    if (!quota) return [];
    return [
      {
        id: a.kind,
        read: async () => {
          const q = await quota.call(a);
          return q ? [q] : [];
        },
        watchFiles: () => quotaFiles?.call(a) ?? [],
      },
    ];
  });
}

/** Display order of providers; others follow, by id. */
const PROVIDER_ORDER: QuotaProvider[] = [
  'anthropic',
  'openai',
  'xai',
  'github-copilot',
  'deepseek',
];

function providerRank(p: QuotaProvider): number {
  const i = PROVIDER_ORDER.indexOf(p);
  return i === -1 ? PROVIDER_ORDER.length : i;
}

/**
 * One snapshot per provider: the newest `fetchedAt` wins, and on a tie the one read first (the
 * earlier source). Sorted by `PROVIDER_ORDER`, then by provider id.
 */
export function mergeQuotas(snapshots: QuotaSnapshot[]): QuotaSnapshot[] {
  const best = new Map<QuotaProvider, QuotaSnapshot>();
  for (const q of snapshots) {
    const kept = best.get(q.provider);
    if (!kept || Date.parse(q.fetchedAt) > Date.parse(kept.fetchedAt)) best.set(q.provider, q);
  }
  return [...best.values()].sort(
    (a, b) =>
      providerRank(a.provider) - providerRank(b.provider) ||
      (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0),
  );
}

/** Current plan quota per provider, merged from every source and kept fresh from their files. */
export class QuotaWatcher {
  private readonly sources: QuotaSource[];
  private readonly pollMs: number;
  private readonly debounceMs: number;
  private readonly log: (msg: string) => void;
  private readonly listeners = new Set<(q: QuotaSnapshot[]) => void>();
  /** Sources whose last read failed; logged once per failure streak, not every poll. */
  private readonly failing = new Set<QuotaSource>();
  private quotas: QuotaSnapshot[] = [];
  private json = '[]';
  private watcher: DirWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private reading: Promise<void> | null = null;
  private readAgain = false;
  private stopped = false;
  /** Each source's last snapshots, to tell a vanished quota from a file caught mid-rewrite. */
  private readonly previous = new Map<QuotaSource, QuotaSnapshot[]>();
  /** Ends each pending confirmation delay early, for `stop()`. */
  private readonly pauses = new Set<() => void>();

  constructor(opts: QuotaWatcherOptions) {
    this.sources = opts.sources;
    this.pollMs = opts.pollMs ?? 30_000;
    this.debounceMs = opts.debounceMs ?? 500;
    this.log = opts.log ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.sources.length === 0) return;
    await this.refresh();
    const files = new Set(this.sources.flatMap((s) => s.watchFiles?.() ?? []));
    if (files.size > 0) {
      const dirs = [...new Set([...files].map((f) => dirname(f)))];
      this.watcher = watchDirs(dirs, (path) => files.has(path) && this.schedule(), {
        pollMs: this.pollMs,
      });
    }
    this.pollTimer = setInterval(() => void this.refresh(), this.pollMs);
    this.pollTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    for (const done of [...this.pauses]) done();
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = this.debounceTimer = null;
    this.listeners.clear();
  }

  current(): QuotaSnapshot[] {
    return this.quotas;
  }

  onChange(cb: (q: QuotaSnapshot[]) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private schedule(): void {
    if (this.stopped || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh();
    }, this.debounceMs);
  }

  /** Read every source; at most one read in flight, a request during it runs after. */
  private refresh(): Promise<void> {
    if (this.reading) {
      this.readAgain = true;
      return this.reading;
    }
    this.reading = (async () => {
      do {
        this.readAgain = false;
        await this.readAll();
      } while (this.readAgain && !this.stopped);
    })().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  /**
   * Reads the sources concurrently, so a slow one (a network fetch) holds the others up by no more
   * than its own read; the results merge in list order all the same.
   */
  private async readAll(): Promise<void> {
    const read = await Promise.all(this.sources.map((source) => this.readConfirmed(source)));
    if (this.stopped) return;
    const quotas = mergeQuotas(read.flat());
    const json = JSON.stringify(quotas);
    if (json === this.json) return;
    this.json = json;
    this.quotas = quotas;
    for (const cb of this.listeners) cb(quotas);
  }

  private async readConfirmed(source: QuotaSource): Promise<QuotaSnapshot[]> {
    let quotas = await this.readOne(source);
    // A config file read while it is being rewritten parses as nothing. Only believe a
    // provider's quota disappeared when a second read a moment later agrees.
    const before = this.previous.get(source) ?? [];
    if (before.some((p) => !quotas.some((q) => q.provider === p.provider))) {
      await this.pause(this.debounceMs);
      if (this.stopped) return [];
      quotas = await this.readOne(source);
    }
    this.previous.set(source, quotas);
    return quotas;
  }

  private async readOne(source: QuotaSource): Promise<QuotaSnapshot[]> {
    try {
      const quotas = await source.read();
      this.failing.delete(source);
      return quotas;
    } catch (err) {
      if (!this.failing.has(source)) this.log(`quota (${source.id}): ${errorText(err)}`);
      this.failing.add(source);
      return [];
    }
  }

  /** A delay that `stop()` cuts short. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.pauses.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.pauses.add(done);
    });
  }
}
