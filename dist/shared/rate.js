export const RATE_KINDS = ['input', 'cacheRead', 'cacheWrite', 'output'];
/** Minutes of history, and so the length of every series. */
export const RATE_MINUTES = 60;
export const MINUTE_MS = 60_000;
/** Tokens per bucket in a scope, oldest first. */
export function rateSeries(rate, scope = {}) {
    const out = new Array(RATE_MINUTES).fill(0);
    for (const [agent, kinds] of Object.entries(rate.agents)) {
        if (!kinds || (scope.agent != null && agent !== scope.agent))
            continue;
        for (const kind of RATE_KINDS) {
            if (scope.kind != null && kind !== scope.kind)
                continue;
            kinds[kind].forEach((n, i) => {
                out[i] = (out[i] ?? 0) + n;
            });
        }
    }
    return out;
}
/**
 * Tokens per minute over the last `minutes` buckets, the newest one partial: the tokens counted
 * in them over the time they cover, from the oldest bucket's start (or `since`, if later) to
 * `at`. At least one minute, so a burst in the first seconds does not read as a huge rate.
 */
export function ratePerMinute(rate, scope = {}, minutes = 5) {
    const series = rateSeries(rate, scope);
    const tokens = series.slice(-minutes).reduce((a, b) => a + b, 0);
    const at = Date.parse(rate.at);
    const oldest = Date.parse(rate.minute) - (minutes - 1) * MINUTE_MS;
    const span = (at - Math.max(oldest, Date.parse(rate.since))) / MINUTE_MS;
    return tokens / Math.max(1, span);
}
/** Tokens in the last complete minute; null when counting began after that minute started. */
export function lastMinute(rate, scope = {}) {
    const start = Date.parse(rate.minute) - MINUTE_MS;
    if (start < Date.parse(rate.since))
        return null;
    return rateSeries(rate, scope).at(-2) ?? 0;
}
/**
 * When counting began, if that was within the hour the series cover: the "60-min" figures then
 * cover only the time since. Null when the whole hour is counted.
 */
export function countedSince(rate) {
    const since = Date.parse(rate.since);
    const windowStart = Date.parse(rate.minute) - (RATE_MINUTES - 1) * MINUTE_MS;
    return since > windowStart ? new Date(since) : null;
}
/**
 * Index of the first bucket counted whole: the first minute that starts at or after `since`.
 * The minute counting began in is partial, so a line drawn from it would dip.
 */
export function firstCountedIndex(rate) {
    const minute = Date.parse(rate.minute);
    const first = Math.ceil(Date.parse(rate.since) / MINUTE_MS) * MINUTE_MS;
    const index = RATE_MINUTES - 1 - Math.round((minute - first) / MINUTE_MS);
    return Math.min(RATE_MINUTES - 1, Math.max(0, index));
}
/** Tokens counted in the whole hour of history. */
export function hourTotal(rate, scope = {}) {
    return rateSeries(rate, scope).reduce((a, b) => a + b, 0);
}
/** Running sessions and how many of them are counted, for all agents or one. */
export function rateCoverage(rate, agent = null) {
    if (agent === null)
        return { running: rate.coverage.running, counted: rate.coverage.counted };
    return rate.coverage.agents[agent] ?? { running: 0, counted: 0 };
}
/** The agent kinds with anything counted in the hour. */
export function rateAgents(rate) {
    return Object.keys(rate.agents);
}
//# sourceMappingURL=rate.js.map