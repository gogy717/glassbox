import { MINUTE_MS, RATE_KINDS, RATE_MINUTES, } from '../shared/rate.js';
const totalsOf = (u) => ({
    input: u.input,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    output: u.output,
});
const zero = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const NO_COVERAGE = { running: 0, counted: 0, agents: {} };
export class RateTracker {
    now;
    /** Each session's totals at its last observation. */
    seen = new Map();
    /** Sessions still settling after they opened: their growth joins the baseline. */
    held = new Set();
    /** Sessions whose next observation brings content read for the first time. */
    absorbing = new Set();
    /** Minute index (epoch minutes) → agent kind → tokens per kind. */
    buckets = new Map();
    since;
    constructor(now = Date.now) {
        this.now = now;
        this.since = now();
    }
    /**
     * One observation of a session's cumulative usage. True when it counted anything. A null
     * usage (the session is not parsed) is no observation at all.
     */
    observe(sessionId, agent, usage, span) {
        if (!usage)
            return false;
        const totals = totalsOf(usage);
        const before = this.seen.get(sessionId);
        const absorbed = this.absorbing.delete(sessionId);
        this.seen.set(sessionId, totals);
        if (!before || absorbed || this.held.has(sessionId))
            return false;
        // A kind that shrank means the totals were recomputed from different data (a rebuild, a file
        // dropped), and the other kinds' growth may be part of that too: none of it is trusted.
        if (RATE_KINDS.some((k) => totals[k] < before[k]))
            return false;
        const now = this.now();
        const minute = Math.floor(now / MINUTE_MS);
        let counted = false;
        for (const k of RATE_KINDS) {
            const grew = totals[k] - before[k];
            if (grew <= 0)
                continue;
            for (const [m, part] of this.shares(grew, span, now))
                this.add(m, agent, k, part);
            counted = true;
        }
        if (counted)
            this.prune(minute);
        return counted;
    }
    add(minute, agent, k, n) {
        const agents = this.buckets.get(minute) ?? new Map();
        this.buckets.set(minute, agents);
        const bucket = agents.get(agent) ?? zero();
        agents.set(agent, bucket);
        bucket[k] += n;
    }
    /**
     * `grew` tokens by minute: all in the current minute, or, over `span`, each minute's share of
     * the span's time, in whole tokens, the remainder with the last minute. A span that ends in
     * the future or starts before the hour is clipped to what the hour keeps; an empty span counts
     * now.
     */
    shares(grew, span, now) {
        const minute = Math.floor(now / MINUTE_MS);
        if (!span)
            return [[minute, grew]];
        const first = (minute - RATE_MINUTES + 1) * MINUTE_MS;
        const to = Math.min(span.to, now);
        const from = Math.max(span.from, first);
        if (!(from < to))
            return [[Math.min(Math.floor(to / MINUTE_MS), minute), grew]];
        const out = [];
        let given = 0;
        for (let m = Math.floor(from / MINUTE_MS); m <= Math.floor((to - 1) / MINUTE_MS); m++) {
            const start = Math.max(from, m * MINUTE_MS);
            const end = Math.min(to, (m + 1) * MINUTE_MS);
            const part = Math.floor((grew * (end - start)) / (to - from));
            out.push([m, part]);
            given += part;
        }
        const last = out.at(-1);
        last[1] += grew - given;
        return out.filter(([, n]) => n > 0);
    }
    /** The session is no longer watched: its next observation is a baseline again. */
    forget(sessionId) {
        this.seen.delete(sessionId);
        this.held.delete(sessionId);
        this.absorbing.delete(sessionId);
    }
    /** The session is settling (just opened): count nothing of it until `release`. */
    hold(sessionId) {
        this.held.add(sessionId);
    }
    release(sessionId) {
        this.held.delete(sessionId);
    }
    /** The session's next observation brings content read for the first time: not spend. */
    absorbNext(sessionId) {
        this.absorbing.add(sessionId);
    }
    /** Whether the session's growth counts now: seen, and not settling. */
    isCounting(sessionId) {
        return this.seen.has(sessionId) && !this.held.has(sessionId);
    }
    snapshot(coverage = NO_COVERAGE) {
        const now = this.now();
        const minute = Math.floor(now / MINUTE_MS);
        this.prune(minute);
        const first = minute - RATE_MINUTES + 1;
        const agents = {};
        for (const [m, perAgent] of this.buckets) {
            // A clock set back leaves buckets "ahead": they are not in this hour.
            if (m < first || m > minute)
                continue;
            for (const [agent, totals] of perAgent) {
                const series = agents[agent] ?? {
                    input: new Array(RATE_MINUTES).fill(0),
                    cacheRead: new Array(RATE_MINUTES).fill(0),
                    cacheWrite: new Array(RATE_MINUTES).fill(0),
                    output: new Array(RATE_MINUTES).fill(0),
                };
                agents[agent] = series;
                for (const k of RATE_KINDS)
                    series[k][m - first] = totals[k];
            }
        }
        return {
            minute: new Date(minute * MINUTE_MS).toISOString(),
            at: new Date(now).toISOString(),
            since: new Date(this.since).toISOString(),
            agents,
            coverage,
        };
    }
    /** Drops buckets older than the hour that ends with `minute`. */
    prune(minute) {
        for (const m of this.buckets.keys())
            if (m <= minute - RATE_MINUTES)
                this.buckets.delete(m);
    }
}
//# sourceMappingURL=rate.js.map