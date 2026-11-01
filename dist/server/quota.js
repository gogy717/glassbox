import { dirname } from 'node:path';
import { errorText } from './open-session.js';
import { watchDirs } from './tail/watch.js';
/** The quota sources of adapters that report one; the source id is the agent kind. */
export function adapterQuotaSources(adapters) {
    return adapters.flatMap((a) => {
        const { quota, quotaFiles } = a;
        if (!quota)
            return [];
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
const PROVIDER_ORDER = [
    'anthropic',
    'openai',
    'xai',
    'github-copilot',
    'deepseek',
];
function providerRank(p) {
    const i = PROVIDER_ORDER.indexOf(p);
    return i === -1 ? PROVIDER_ORDER.length : i;
}
/**
 * One snapshot per provider: the newest `fetchedAt` wins, and on a tie the one read first (the
 * earlier source). Sorted by `PROVIDER_ORDER`, then by provider id.
 */
export function mergeQuotas(snapshots) {
    const time = (q) => {
        const t = Date.parse(q.fetchedAt);
        return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
    };
    const best = new Map();
    for (const q of snapshots) {
        const kept = best.get(q.provider);
        if (!kept || time(q) > time(kept))
            best.set(q.provider, q);
    }
    return [...best.values()].sort((a, b) => providerRank(a.provider) - providerRank(b.provider) ||
        (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
}
/**
 * Current plan quota per provider, merged from every source and kept fresh from their files.
 * Each source is read on its own and the merge republished as each read settles, so a slow
 * source (a network fetch) never delays another's update.
 */
export class QuotaWatcher {
    sources;
    pollMs;
    debounceMs;
    readTimeoutMs;
    staleReason;
    log;
    listeners = new Set();
    /** Sources whose last read failed; logged once per failure streak, not every poll. */
    failing = new Set();
    quotas = [];
    json = '[]';
    watcher = null;
    pollTimer = null;
    debounceTimer = null;
    reads;
    stopped = false;
    /**
     * Each source's last snapshots: merged into `quotas`, and kept to tell a vanished quota from a
     * file caught mid-rewrite.
     */
    latest = new Map();
    /** Ends each pending confirmation delay early, for `stop()`. */
    pauses = new Set();
    constructor(opts) {
        this.sources = opts.sources;
        this.reads = new Map(opts.sources.map((s) => [s, { reading: null, again: false }]));
        this.pollMs = opts.pollMs ?? 30_000;
        this.debounceMs = opts.debounceMs ?? 500;
        this.readTimeoutMs = opts.readTimeoutMs ?? 15_000;
        this.staleReason = opts.staleReason ?? (() => undefined);
        this.log = opts.log ?? (() => { });
    }
    async start() {
        if (this.sources.length === 0)
            return;
        await this.refresh();
        // Stopped while the first reads were in flight: watch nothing.
        if (this.stopped)
            return;
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
    stop() {
        this.stopped = true;
        for (const done of [...this.pauses])
            done();
        this.watcher?.close();
        this.watcher = null;
        if (this.pollTimer)
            clearInterval(this.pollTimer);
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        this.pollTimer = this.debounceTimer = null;
        this.listeners.clear();
    }
    current() {
        return this.quotas;
    }
    onChange(cb) {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }
    schedule() {
        if (this.stopped || this.debounceTimer)
            return;
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.refresh();
        }, this.debounceMs);
    }
    /** Reads every source, concurrently; resolves once each has settled (or timed out). */
    async refresh() {
        await Promise.all([...this.reads].map(([source, read]) => this.refreshSource(source, read)));
    }
    refreshSource(source, read) {
        if (read.reading) {
            read.again = true;
            return read.reading;
        }
        read.reading = (async () => {
            do {
                read.again = false;
                await this.readSource(source);
            } while (read.again && !this.stopped);
        })().finally(() => {
            read.reading = null;
        });
        return read.reading;
    }
    async readSource(source) {
        let quotas = await this.readOne(source);
        // A config file read while it is being rewritten parses as nothing. Only believe a
        // provider's quota disappeared when a second read a moment later agrees.
        const before = this.latest.get(source) ?? [];
        if (before.some((p) => !quotas.some((q) => q.provider === p.provider))) {
            await this.pause(this.debounceMs);
            if (this.stopped)
                return;
            quotas = await this.readOne(source);
        }
        if (this.stopped)
            return;
        this.latest.set(source, quotas);
        this.publish();
    }
    /**
     * Merges every source's latest snapshots, in source order, says why each stale one is stale,
     * and tells listeners of a change. A fetcher's reason changes only on a read, which publishes.
     */
    publish() {
        const quotas = mergeQuotas(this.sources.flatMap((s) => this.latest.get(s) ?? [])).map((q) => {
            const staleReason = q.stale ? this.staleReason(q) : undefined;
            return staleReason ? { ...q, staleReason } : q;
        });
        const json = JSON.stringify(quotas);
        if (json === this.json)
            return;
        this.json = json;
        this.quotas = quotas;
        for (const cb of this.listeners)
            cb(quotas);
    }
    async readOne(source) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer within ${this.readTimeoutMs / 1000}s`)), this.readTimeoutMs);
            timer.unref();
        });
        try {
            const quotas = await Promise.race([source.read(), timeout]);
            this.failing.delete(source);
            return quotas;
        }
        catch (err) {
            if (!this.failing.has(source))
                this.log(`quota (${source.id}): ${errorText(err)}`);
            this.failing.add(source);
            return [];
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** A delay that `stop()` cuts short. */
    pause(ms) {
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
//# sourceMappingURL=quota.js.map