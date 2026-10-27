export const DEFAULT_INTERVAL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
export function periodicFetch(opts) {
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    const log = opts.log ?? (() => { });
    const now = opts.now ?? Date.now;
    let last = null;
    let lastAttempt = Number.NEGATIVE_INFINITY;
    let inFlight = null;
    /** The last failure logged, so a failure repeating every interval is logged once. */
    let lastProblem = null;
    let reason = null;
    async function refresh() {
        let result;
        try {
            result = await opts.attempt();
        }
        catch (err) {
            // The message could quote a credential file (JSON.parse does), so only the name is shown.
            result = { problem: `failed (${err instanceof Error ? err.name : 'error'})` };
        }
        if ('problem' in result) {
            if (result.problem !== lastProblem)
                log(`${opts.name}: ${result.problem}`);
            lastProblem = result.problem;
            reason = result.reason ?? 'fetch-failed';
            return;
        }
        last = { value: result.ok, fetchedAtMs: now() };
        if (lastProblem !== null)
            log(`${opts.name}: working again`);
        lastProblem = null;
        reason = null;
    }
    return {
        async latest() {
            if (!inFlight && now() - lastAttempt >= intervalMs) {
                lastAttempt = now();
                inFlight = refresh().finally(() => {
                    inFlight = null;
                });
            }
            if (inFlight)
                await inFlight;
            return last;
        },
        problem: () => reason,
    };
}
function requestError(err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
        return `no answer within ${TIMEOUT_MS / 1000} s`;
    }
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null;
    return cause ? `${message}: ${cause}` : message;
}
/**
 * GET `url` and parse the JSON answer. Redirects are refused, so the credential in `headers`
 * reaches `url`'s host and no other; `secret` is cut out of any error text.
 */
export async function getJson(doFetch, url, headers, secret, what) {
    let res;
    try {
        res = await doFetch(url, {
            headers,
            redirect: 'error',
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    }
    catch (err) {
        const text = requestError(err);
        return { problem: `request failed (${secret ? text.replaceAll(secret, '…') : text})` };
    }
    if (!res.ok) {
        await res.body?.cancel().catch(() => { });
        return { problem: `${what} answered HTTP ${res.status}` };
    }
    try {
        return { ok: await res.json() };
    }
    catch {
        return { problem: `${what} did not answer JSON` };
    }
}
//# sourceMappingURL=periodic-fetch.js.map