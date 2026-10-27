import { weekWindow, } from '../shared/week.js';
import { isActive } from './live.js';
import { sessionBucketsPausing, sliceSession } from './week-buckets.js';
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));
/** Busy or waiting: it may be working in files its `updatedAt` does not follow. */
const running = (s) => isActive(s.live);
/** `onProgress` with `done` held from going down (a plan can shrink when it is made again). */
export function steady(onProgress) {
    if (!onProgress)
        return undefined;
    let last = 0;
    return (p) => {
        last = Math.min(p.total, Math.max(last, p.done));
        onProgress({ type: 'progress', done: last, total: p.total });
    };
}
export class WeekService {
    store;
    cache = new Map();
    job = null;
    stopped = false;
    /** One very large read at a time: the next waits for this to settle. */
    bigRead = Promise.resolve();
    concurrency;
    bigBytes;
    reparseMs;
    now;
    log;
    repoOf;
    constructor(store, opts = {}) {
        this.store = store;
        this.concurrency = Math.max(1, opts.concurrency ?? 2);
        this.repoOf = opts.repoOf ?? null;
        this.bigBytes = opts.bigBytes ?? 64 * 1024 * 1024;
        this.reparseMs = opts.reparseMs ?? 30_000;
        this.now = opts.now ?? Date.now;
        this.log = opts.log ?? (() => { });
    }
    /** No more reading: a computation under way ends at its next session, and none starts. */
    stop() {
        this.stopped = true;
    }
    /**
     * The window's figures. `onProgress` hears where the reading is at once, then after each
     * session read; `done` never goes down.
     */
    async compute(kind, opts = {}, onProgress) {
        const refresh = opts.refresh === true;
        const hear = steady(onProgress);
        for (;;) {
            if (this.stopped)
                throw new Error('stopped');
            const current = this.job;
            if (!current)
                break;
            // A refresh answers a plain request too; a plain one does not answer a refresh.
            if (current.kind === kind && (current.refresh || !refresh))
                return this.join(current, hear);
            // Another window is being read: say how many of this one's sessions are ready, and keep
            // saying as that reading fills the cache, until this one's turn comes.
            const plan = this.plan(kind, this.now());
            const ready = () => {
                const left = new Set(this.plan(kind, this.now()).stale.map((s) => s.id));
                return plan.wanted.filter((s) => !left.has(s.id)).length;
            };
            const tell = () => hear?.({ type: 'progress', done: ready(), total: plan.wanted.length });
            tell();
            current.listeners.add(tell);
            try {
                await current.promise.catch(() => { });
            }
            finally {
                current.listeners.delete(tell);
            }
        }
        return this.join(this.start(kind, refresh), hear);
    }
    start(kind, refresh) {
        const job = {
            kind,
            refresh,
            listeners: new Set(),
            last: { type: 'progress', done: 0, total: 0 },
            promise: Promise.resolve(),
        };
        this.job = job;
        job.promise = this.run(job).finally(() => {
            if (this.job === job)
                this.job = null;
        });
        return job;
    }
    async join(job, onProgress) {
        if (onProgress) {
            job.listeners.add(onProgress);
            onProgress(job.last);
        }
        try {
            return await job.promise;
        }
        finally {
            if (onProgress)
                job.listeners.delete(onProgress);
        }
    }
    /**
     * The sessions a window counts: those last written since it began, and every running one; of
     * them, those whose buckets are not known to be current: not read yet, changed since (by their
     * `updatedAt`), running now, or running when they were read.
     */
    plan(kind, now) {
        const window = weekWindow(kind, now);
        const from = window.hourStarts[0] ?? now;
        const wanted = this.store
            .weekSessions()
            .filter((s) => running(s) || !(Date.parse(s.updatedAt) < from));
        const stale = wanted.filter((s) => {
            const c = this.cache.get(s.id);
            return !c || running(s) || c.running || c.updatedAt !== s.updatedAt;
        });
        return { window, wanted, stale };
    }
    /** Forgets sessions no longer listed, and finished ones written before both windows began. */
    prune(listed, now) {
        const oldest = Math.min(...['week', '7d'].map((k) => weekWindow(k, now).hourStarts[0] ?? now));
        const keep = new Set(listed.filter((s) => running(s) || !(Date.parse(s.updatedAt) < oldest)).map((s) => s.id));
        for (const id of this.cache.keys())
            if (!keep.has(id))
                this.cache.delete(id);
    }
    /**
     * Reads one session (`size` bytes) into the cache, bucketed as of `asOf` (the computation's
     * time); its bytes, or null when it was not read.
     */
    async read(s, size, asOf) {
        const big = size >= this.bigBytes;
        let release = () => { };
        if (big) {
            const before = this.bigRead;
            this.bigRead = new Promise((resolve) => {
                release = resolve;
            });
            await before;
        }
        try {
            if (this.stopped)
                return null;
            const got = await this.store.readSession(s.id);
            if (!got || this.stopped)
                return null;
            const buckets = await sessionBucketsPausing(got.snapshot, asOf, yieldToLoop);
            if (this.stopped)
                return null;
            this.cache.set(s.id, { buckets, updatedAt: s.updatedAt, readAt: asOf, running: running(s) });
            return got.bytes;
        }
        finally {
            release();
        }
    }
    async run(job) {
        const started = performance.now();
        const now = this.now();
        this.prune(this.store.weekSessions(), now);
        const { window, wanted, stale } = this.plan(job.kind, now);
        const total = wanted.length;
        let done = total - stale.length;
        const emit = () => {
            job.last = { type: 'progress', done, total };
            for (const cb of job.listeners)
                cb(job.last);
        };
        emit();
        // Open sessions are bucketed again from memory every time; a running one that has to be
        // parsed, no sooner than `reparseMs` after its last parse, unless a refresh asks.
        const sizeOf = this.store.sizeOf?.bind(this.store);
        const sized = await Promise.all(stale.map(async (s) => ({ s, size: sizeOf ? await sizeOf(s.id).catch(() => 0) : 0 })));
        const toRead = sized.filter(({ s, size }) => {
            const c = this.cache.get(s.id);
            return !c || job.refresh || size === 0 || !(running(s) && now - c.readAt < this.reparseMs);
        });
        if (toRead.length < sized.length) {
            done += sized.length - toRead.length;
            emit();
        }
        // The smallest first: a large session waits for the small ones, never the other way.
        toRead.sort((a, b) => a.size - b.size);
        let read = 0;
        let failed = 0;
        let bytes = 0;
        let next = 0;
        const worker = async () => {
            for (let item = toRead[next++]; item && !this.stopped; item = toRead[next++]) {
                const { s, size } = item;
                try {
                    const got = await this.read(s, size, now);
                    if (got === null)
                        failed++;
                    else {
                        bytes += got;
                        read++;
                    }
                }
                catch (err) {
                    failed++;
                    this.log(`week: could not read ${s.id}: ${err instanceof Error ? err.message : err}`);
                }
                done++;
                emit();
                // Between sessions, let the live view's requests and events through.
                await yieldToLoop();
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.concurrency, toRead.length) }, worker));
        if (this.stopped)
            throw new Error('stopped');
        // Every session not read again was finished when read and is listed as then: the same now.
        // So the result is as of now (R27), save a running one parsed in the last `reparseMs`.
        const sessions = [];
        for (const s of wanted) {
            const c = this.cache.get(s.id);
            if (!c)
                continue;
            const row = sliceSession(c.buckets, window, s.tags ?? []);
            if (!row)
                continue;
            if (this.repoOf && row.cwd)
                row.repo = this.repoOf(row.cwd);
            sessions.push(row);
        }
        sessions.sort((a, b) => b.inWindow.agentMs - a.inWindow.agentMs || b.inWindow.activeMs - a.inWindow.activeMs);
        return {
            window,
            sessions,
            asOf: now,
            stats: {
                considered: total,
                read,
                cached: total - toRead.length,
                failed,
                bytes,
                ms: Math.round(performance.now() - started),
            },
        };
    }
}
//# sourceMappingURL=week.js.map