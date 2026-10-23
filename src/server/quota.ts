import { dirname } from 'node:path';
import type { AgentAdapter } from '../core/adapter.js';
import type { QuotaSnapshot } from '../core/model.js';
import { errorText } from './open-session.js';
import { type DirWatcher, watchDirs } from './tail/watch.js';

export interface QuotaWatcherOptions {
  adapters: AgentAdapter[];
  /** Re-read interval: a quota also turns `stale` with age, without any file changing. */
  pollMs?: number;
  /** After a file change, wait this long and read once; the agent rewrites its config often. */
  debounceMs?: number;
  log?: (msg: string) => void;
}

/** Current plan quota of every adapter that reports one, kept fresh from its quota files. */
export class QuotaWatcher {
  private readonly adapters: AgentAdapter[];
  private readonly pollMs: number;
  private readonly debounceMs: number;
  private readonly log: (msg: string) => void;
  private readonly listeners = new Set<(q: QuotaSnapshot[]) => void>();
  /** Adapters whose last read failed; logged once per failure streak, not every poll. */
  private readonly failing = new Set<AgentAdapter>();
  private quotas: QuotaSnapshot[] = [];
  private json = '[]';
  private watcher: DirWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private reading: Promise<void> | null = null;
  private readAgain = false;
  private stopped = false;
  /** Each adapter's last quota, to tell a vanished quota from a file caught mid-rewrite. */
  private readonly previous = new Map<AgentAdapter, QuotaSnapshot>();
  private confirmTimer: NodeJS.Timeout | null = null;
  private confirmDone: (() => void) | null = null;

  constructor(opts: QuotaWatcherOptions) {
    this.adapters = opts.adapters.filter((a) => a.quota);
    this.pollMs = opts.pollMs ?? 30_000;
    this.debounceMs = opts.debounceMs ?? 500;
    this.log = opts.log ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.adapters.length === 0) return;
    await this.refresh();
    const files = new Set(this.adapters.flatMap((a) => a.quotaFiles?.() ?? []));
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
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmDone?.();
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

  /** Read every adapter's quota; at most one read in flight, a request during it runs after. */
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

  private async readAll(): Promise<void> {
    const quotas: QuotaSnapshot[] = [];
    for (const adapter of this.adapters) {
      let q = await this.readOne(adapter);
      // A config file read while it is being rewritten parses as nothing. Only believe a
      // quota disappeared when a second read a moment later agrees.
      if (q === null && this.previous.has(adapter)) {
        await this.pause(this.debounceMs);
        if (this.stopped) return;
        q = await this.readOne(adapter);
      }
      if (q) {
        quotas.push(q);
        this.previous.set(adapter, q);
      } else {
        this.previous.delete(adapter);
      }
    }
    if (this.stopped) return;
    const json = JSON.stringify(quotas);
    if (json === this.json) return;
    this.json = json;
    this.quotas = quotas;
    for (const cb of this.listeners) cb(quotas);
  }

  private async readOne(adapter: AgentAdapter): Promise<QuotaSnapshot | null> {
    try {
      const q = (await adapter.quota?.()) ?? null;
      this.failing.delete(adapter);
      return q;
    } catch (err) {
      if (!this.failing.has(adapter)) this.log(`quota (${adapter.kind}): ${errorText(err)}`);
      this.failing.add(adapter);
      return null;
    }
  }

  /** A delay that `stop()` cuts short. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.confirmDone = () => {
        this.confirmDone = null;
        this.confirmTimer = null;
        resolve();
      };
      this.confirmTimer = setTimeout(() => this.confirmDone?.(), ms);
    });
  }
}
