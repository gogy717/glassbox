import { addUsage, emptyUsage } from '../core/usage.js';
import { burnTokens, mayUse, requestProvider, } from '../shared/quota-burn.js';
import { isActive } from './live.js';
/** Kept this long after a finished session was last written: past the longest window, a month. */
const KEEP_MS = 32 * 24 * 3_600_000;
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));
const running = (s) => isActive(s.live);
const time = (iso) => {
    const t = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(t) ? t : null;
};
/** Each request's start (else its end, else its turn's start), provider and usage. */
function seenOf(snap) {
    const turnStart = new Map(snap.turns.map((t) => [t.id, time(t.startedAt)]));
    const agent = snap.session.agent;
    return snap.requests.flatMap((r) => {
        const at = time(r.startedAt) ?? time(r.endedAt) ?? (r.turnId ? turnStart.get(r.turnId) : null) ?? null;
        return at === null ? [] : [{ at, provider: requestProvider(agent, r.model), usage: r.usage }];
    });
}
export class QuotaBurnService {
    store;
    cache = new Map();
    /** Reads under way, so two requests at once read a session once. */
    reading = new Map();
    reparseMs;
    now;
    log;
    constructor(store, opts = {}) {
        this.store = store;
        this.reparseMs = opts.reparseMs ?? 30_000;
        this.now = opts.now ?? Date.now;
        this.log = opts.log ?? (() => { });
    }
    /** The sessions that used `provider` since `since` (epoch ms), most tokens first. */
    async compute(provider, since) {
        const now = this.now();
        const listed = this.store.weekSessions();
        this.prune(listed, now);
        const wanted = listed.filter((s) => mayUse(s.agent, provider) && (running(s) || !(Date.parse(s.updatedAt) < since)));
        for (const s of wanted) {
            if (!(await this.isCurrent(s, now))) {
                await this.read(s, now);
                await yieldToLoop();
            }
        }
        const sessions = [];
        let total = 0;
        for (const s of wanted) {
            const c = this.cache.get(s.id);
            if (!c)
                continue;
            const usage = emptyUsage();
            let requests = 0;
            for (const r of c.requests) {
                if (r.provider !== provider || r.at < since || r.at > now)
                    continue;
                requests++;
                if (r.usage)
                    addUsage(usage, r.usage);
            }
            if (requests === 0)
                continue;
            const tokens = burnTokens(usage);
            total += tokens;
            sessions.push({
                id: s.id,
                agent: s.agent,
                project: s.project,
                cwd: s.cwd,
                ...(s.repo !== undefined ? { repo: s.repo } : {}),
                title: s.title,
                usage,
                requests,
                tokens,
                share: 0,
            });
        }
        // No tokens reported at all: the shares are of the requests (see `QuotaBurn.counted`).
        const counted = total > 0 || sessions.length === 0 ? 'tokens' : 'requests';
        const all = sessions.reduce((n, s) => n + s.requests, 0);
        for (const s of sessions)
            s.share = counted === 'tokens' ? s.tokens / total : s.requests / all;
        sessions.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests || (a.id < b.id ? -1 : 1));
        return { provider, since, asOf: now, sessions, tokens: total, counted };
    }
    /** Whether what is kept of `s` is as it is now: read since it changed, and not due again. */
    async isCurrent(s, now) {
        const c = this.cache.get(s.id);
        if (!c || c.updatedAt !== s.updatedAt)
            return false;
        if (!running(s) && !c.running)
            return true;
        // Running: an open session reads from memory (nothing to go through), so read it again.
        const size = this.store.sizeOf ? await this.store.sizeOf(s.id).catch(() => 0) : 1;
        return size > 0 && now - c.readAt < this.reparseMs;
    }
    read(s, now) {
        const under = this.reading.get(s.id);
        if (under)
            return under;
        const job = (async () => {
            try {
                const got = await this.store.readSession(s.id);
                if (!got)
                    return;
                this.cache.set(s.id, {
                    updatedAt: s.updatedAt,
                    readAt: now,
                    running: running(s),
                    requests: seenOf(got.snapshot),
                });
            }
            catch (err) {
                this.log(`quota burn: could not read ${s.id}: ${err instanceof Error ? err.message : err}`);
            }
        })().finally(() => this.reading.delete(s.id));
        this.reading.set(s.id, job);
        return job;
    }
    /** Forgets sessions no longer listed, and finished ones last written before any window. */
    prune(listed, now) {
        const keep = new Set(listed
            .filter((s) => running(s) || !(Date.parse(s.updatedAt) < now - KEEP_MS))
            .map((s) => s.id));
        for (const id of this.cache.keys())
            if (!keep.has(id))
                this.cache.delete(id);
    }
}
//# sourceMappingURL=quota-burn.js.map