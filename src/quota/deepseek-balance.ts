/**
 * On unless `--no-fetch-quota`: the prepaid balance of a DeepSeek API account, asked of
 * DeepSeek's public API with the person's own `DEEPSEEK_API_KEY`. No agent is involved, so the
 * snapshot's `agent` is null.
 *
 * The key is read from the environment only when a request is due, is sent to api.deepseek.com
 * and nowhere else (no redirects), and is never logged or kept between requests.
 */
import type { QuotaSnapshot } from '../core/model.js';
import type { FetchStatus, QuotaSource } from '../core/quota-source.js';
import { type Attempt, getJson, periodicFetch } from './periodic-fetch.js';
import { obj, STALE_MS } from './shared.js';

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
export const DEEPSEEK_KEY_ENV = 'DEEPSEEK_API_KEY';

export type Balance = NonNullable<QuotaSnapshot['balance']>;

/** DeepSeek states amounts as decimal strings ("9.26"); numbers are accepted too. */
function decimal(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !/^\s*-?\d+(\.\d+)?\s*$/.test(v)) return null;
  return Number(v);
}

/**
 * The balance in a `/user/balance` answer, or null when it holds none. An account lists one
 * entry per currency (CNY, USD) and is topped up in one of them, so the first entry with money
 * on it is the one shown; when none has, the first entry.
 */
export function deepseekBalance(body: unknown): Balance | null {
  const infos = obj(body)?.balance_infos;
  const balances: Balance[] = [];
  for (const info of Array.isArray(infos) ? infos : []) {
    const i = obj(info);
    const amount = decimal(i?.total_balance);
    const currency = i?.currency;
    if (amount !== null && typeof currency === 'string' && currency.trim()) {
      balances.push({ amount, currency: currency.trim() });
    }
  }
  return balances.find((b) => b.amount > 0) ?? balances[0] ?? null;
}

export function balanceSnapshot(balance: Balance, fetchedAtMs: number, now: number): QuotaSnapshot {
  return {
    provider: 'deepseek',
    agent: null,
    plan: null,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    stale: now - fetchedAtMs > STALE_MS,
    windows: [],
    extraUsage: null,
    balance,
    source: 'deepseek-api',
  };
}

export interface DeepSeekBalanceOptions {
  /** Where `DEEPSEEK_API_KEY` is read from when a request is due. Default: process.env. */
  env?: Record<string, string | undefined>;
  /** Minimum time between requests, failed or not. */
  intervalMs?: number;
  log?: (msg: string) => void;
  /** Injected in tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

export function createDeepSeekBalanceSource(
  opts: DeepSeekBalanceOptions = {},
): QuotaSource & FetchStatus {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;

  async function attempt(): Promise<Attempt<Balance>> {
    const key = env[DEEPSEEK_KEY_ENV]?.trim();
    if (!key) return { problem: `${DEEPSEEK_KEY_ENV} is not set`, reason: 'no-credentials' };
    const res = await getJson(
      doFetch,
      DEEPSEEK_BALANCE_URL,
      { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      key,
      'the balance endpoint',
    );
    if ('problem' in res) return res;
    // An error envelope holds no balance; it must not replace a real one.
    const balance = deepseekBalance(res.ok);
    return balance
      ? { ok: balance }
      : { problem: 'the balance endpoint answered in an unknown format' };
  }

  const loop = periodicFetch({
    attempt,
    name: 'quota fetch (DeepSeek)',
    intervalMs: opts.intervalMs,
    log: opts.log,
    now,
  });

  return {
    id: 'deepseek-api',
    async read() {
      const last = await loop.latest();
      // Rebuilt on every read so `stale` follows the clock.
      return last ? [balanceSnapshot(last.value, last.fetchedAtMs, now())] : [];
    },
    problem: loop.problem,
  };
}
