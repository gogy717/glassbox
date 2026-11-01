import { permissionEvents, ruleRows, rulesWindowStart, } from '../shared/permissions.js';
import { steady } from './week.js';
import { BigReads, readWindowSessions, running, staleSessions, } from './window-sessions.js';
/** Agents whose calls have permission rules glassbox can read. */
const WITH_RULES = new Set(['claude-code', 'codex']);
/** The session's repository as listed; a session without one is in its own directory. */
function placeOf(s) {
    const repo = s.repo ?? null;
    if (repo)
        return { project: { root: repo.root, name: repo.name }, tree: repo.dir };
    return { project: { root: s.cwd, name: s.project }, tree: s.cwd };
}
export class RulesService {
    store;
    opts;
    cache = new Map();
    job = null;
    stopped = false;
    bigReads = new BigReads();
    concurrency;
    bigBytes;
    reparseMs;
    now;
    log;
    constructor(store, opts = {}) {
        this.store = store;
        this.opts = opts;
        this.concurrency = Math.max(1, opts.concurrency ?? 2);
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
     * The window's rules. `onProgress` hears where the reading is at once, then after each session
     * read; `done` never goes down.
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
            if (current.kind === kind && (current.refresh || !refresh))
                return this.join(current, hear);
            const plan = this.plan(kind, this.now());
            const tell = () => {
                const left = new Set(this.plan(kind, this.now()).stale.map((s) => s.id));
                const ready = plan.wanted.filter((s) => !left.has(s.id)).length;
                hear?.({ type: 'progress', done: ready, total: plan.wanted.length });
            };
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
     * The sessions a window counts: those of an agent with rules last written since it began, and
     * every running one; of them, those not known to be as cached.
     */
    plan(kind, now) {
        const from = rulesWindowStart(kind, now);
        const wanted = this.store
            .weekSessions()
            .filter((s) => WITH_RULES.has(s.agent) &&
            (running(s) || from === null || !(Date.parse(s.updatedAt) < from)));
        return { from, wanted, stale: staleSessions(wanted, this.cache) };
    }
    /** Keeps one session read as its permission events. */
    async keep(s, got, asOf) {
        const { project, tree } = placeOf(s);
        const events = permissionEvents(got.snapshot, { cwd: s.cwd, tree, home: this.opts.home ?? null }, this.opts.decisions?.());
        this.cache.set(s.id, {
            events,
            project,
            tree,
            updatedAt: s.updatedAt,
            readAt: asOf,
            running: running(s),
        });
        return true;
    }
    async run(job) {
        const started = performance.now();
        const now = this.now();
        const listed = new Set(this.store.weekSessions().map((s) => s.id));
        for (const id of this.cache.keys())
            if (!listed.has(id))
                this.cache.delete(id);
        const { from, wanted, stale } = this.plan(job.kind, now);
        const total = wanted.length;
        let done = total - stale.length;
        const emit = () => {
            job.last = { type: 'progress', done, total };
            for (const cb of job.listeners)
                cb(job.last);
        };
        emit();
        const reads = await readWindowSessions({
            store: this.store,
            stale,
            cache: this.cache,
            now,
            refresh: job.refresh,
            reparseMs: this.reparseMs,
            concurrency: this.concurrency,
            bigBytes: this.bigBytes,
            bigReads: this.bigReads,
            stopped: () => this.stopped,
            log: this.log,
            label: 'rules',
            advance: (by) => {
                done += by;
                emit();
            },
            keep: (s, got, asOf) => this.keep(s, got, asOf),
        });
        if (this.stopped)
            throw new Error('stopped');
        const sessions = [];
        const dirs = new Map();
        for (const s of wanted) {
            const c = this.cache.get(s.id);
            if (!c)
                continue;
            sessions.push({ sessionId: s.id, project: c.project, events: c.events });
            const asked = c.events.some((e) => from === null || !(Date.parse(e.at) < from));
            const { root } = c.project;
            if (!asked || root === null)
                continue;
            const set = dirs.get(root) ?? new Set([root]);
            if (c.tree)
                set.add(c.tree);
            dirs.set(root, set);
        }
        let settings = [];
        try {
            settings =
                (await this.opts.readSettings?.([...dirs].map(([root, set]) => ({ root, dirs: [...set] })))) ?? [];
        }
        catch (err) {
            this.log(`rules: could not read the settings: ${err instanceof Error ? err.message : err}`);
        }
        return {
            window: { kind: job.kind, from, now },
            rows: ruleRows(sessions, { from, settings }),
            settings,
            yourSettings: this.opts.yourSettings ?? null,
            asOf: now,
            stats: {
                considered: total,
                read: reads.read,
                cached: total - reads.tried,
                failed: reads.failed,
                ms: Math.round(performance.now() - started),
            },
        };
    }
}
//# sourceMappingURL=rules.js.map