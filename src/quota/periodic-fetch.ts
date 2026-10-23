/**
 * The request loop behind the opt-in (`--fetch-quota`) usage fetchers of other providers, with
 * the guarantees of `adapters/claude-code/quota-fetch.ts`: at most one request per interval,
 * failed or not; one request at a time, shared by concurrent reads; the last good answer kept
 * through failures; a failure logged once per streak.
 *
 * Callers read their credential inside `attempt`, so nothing is read before the first request
 * and the credential lives no longer than that call.
 */

export const DEFAULT_INTERVAL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

/** A usable answer, or why there is none (for the log; never includes a credential). */
export type Attempt<T> = { ok: T } | { problem: string };

export interface Fetched<T> {
  value: T;
  fetchedAtMs: number;
}

export interface PeriodicFetch<T> {
  /** The last good answer, fetching first when the interval has passed. Never rejects. */
  latest(): Promise<Fetched<T> | null>;
}

export interface PeriodicFetchOptions<T> {
  /** One request. Should not reject; a rejection is logged by name only. */
  attempt: () => Promise<Attempt<T>>;
  /** Log prefix, e.g. "quota fetch (DeepSeek)". */
  name: string;
  /** Minimum time between requests, failed or not. */
  intervalMs?: number;
  log?: (msg: string) => void;
  now?: () => number;
}

export function periodicFetch<T>(opts: PeriodicFetchOptions<T>): PeriodicFetch<T> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;

  let last: Fetched<T> | null = null;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  /** The last failure logged, so a failure repeating every interval is logged once. */
  let lastProblem: string | null = null;

  async function refresh(): Promise<void> {
    let result: Attempt<T>;
    try {
      result = await opts.attempt();
    } catch (err) {
      // The message could quote a credential file (JSON.parse does), so only the name is shown.
      result = { problem: `failed (${err instanceof Error ? err.name : 'error'})` };
    }
    if ('problem' in result) {
      if (result.problem !== lastProblem) log(`${opts.name}: ${result.problem}`);
      lastProblem = result.problem;
      return;
    }
    last = { value: result.ok, fetchedAtMs: now() };
    if (lastProblem !== null) log(`${opts.name}: working again`);
    lastProblem = null;
  }

  return {
    async latest() {
      if (!inFlight && now() - lastAttempt >= intervalMs) {
        lastAttempt = now();
        inFlight = refresh().finally(() => {
          inFlight = null;
        });
      }
      if (inFlight) await inFlight;
      return last;
    },
  };
}

function requestError(err: unknown): string {
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
export async function getJson(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  secret: string,
  what: string,
): Promise<Attempt<unknown>> {
  let res: Response;
  try {
    res = await doFetch(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const text = requestError(err);
    return { problem: `request failed (${secret ? text.replaceAll(secret, '…') : text})` };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { problem: `${what} answered HTTP ${res.status}` };
  }
  try {
    return { ok: await res.json() };
  } catch {
    return { problem: `${what} did not answer JSON` };
  }
}
