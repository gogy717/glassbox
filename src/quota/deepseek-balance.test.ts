import { describe, expect, it, vi } from 'vitest';
import {
  createDeepSeekBalanceSource,
  DEEPSEEK_BALANCE_URL,
  deepseekBalance,
} from './deepseek-balance.js';

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const KEY = 'sk-deepseek-secret-fixture';

/** The shape `GET /user/balance` answers, with synthetic amounts. */
const balanceBody = (...infos: Array<[string, string]>) => ({
  is_available: true,
  balance_infos: infos.map(([currency, total]) => ({
    currency,
    total_balance: total,
    granted_balance: '0.00',
    topped_up_balance: total,
  })),
});

function setup(
  opts: {
    env?: Record<string, string | undefined>;
    respond?: () => Response | Promise<Response>;
  } = {},
) {
  let now = NOW;
  const logs: string[] = [];
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      opts.respond?.() ?? Response.json(balanceBody(['CNY', '12.30'])),
  );
  const source = createDeepSeekBalanceSource({
    env: opts.env ?? { DEEPSEEK_API_KEY: KEY },
    intervalMs: 5 * 60_000,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => now,
    log: (m) => logs.push(m),
  });
  return { source, fetch, logs, advance: (ms: number) => (now += ms) };
}

describe('deepseekBalance', () => {
  it('reads the decimal-string total of the only currency', () => {
    expect(deepseekBalance(balanceBody(['CNY', '9.26']))).toEqual({
      amount: 9.26,
      currency: 'CNY',
    });
  });

  it('shows the currency with money on it, else the first listed', () => {
    expect(deepseekBalance(balanceBody(['CNY', '0.00'], ['USD', '4.50']))).toEqual({
      amount: 4.5,
      currency: 'USD',
    });
    expect(deepseekBalance(balanceBody(['CNY', '0.00'], ['USD', '0.00']))).toEqual({
      amount: 0,
      currency: 'CNY',
    });
  });

  it('skips entries it cannot read and finds nothing in an error envelope', () => {
    expect(
      deepseekBalance({
        balance_infos: [{ currency: 'CNY', total_balance: 'n/a' }, { total_balance: '1' }],
      }),
    ).toBeNull();
    expect(deepseekBalance({ error: { message: 'Authentication Fails' } })).toBeNull();
    expect(deepseekBalance(null)).toBeNull();
  });
});

describe('createDeepSeekBalanceSource', () => {
  it('asks DeepSeek with the key and reports a balance-only snapshot', async () => {
    const { source, fetch } = setup();
    expect(source.id).toBe('deepseek-api');
    expect(await source.read()).toEqual([
      {
        provider: 'deepseek',
        agent: null,
        plan: null,
        fetchedAt: new Date(NOW).toISOString(),
        stale: false,
        windows: [],
        extraUsage: null,
        balance: { amount: 12.3, currency: 'CNY' },
        source: 'deepseek-api',
      },
    ]);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(DEEPSEEK_BALANCE_URL);
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    expect(init?.redirect).toBe('error');
  });

  it('asks at most once per interval, and turns stale with age', async () => {
    const { source, fetch, advance } = setup({
      respond: () => {
        throw new Error('offline');
      },
    });
    fetch.mockImplementationOnce(async () => Response.json(balanceBody(['CNY', '1.00'])));
    await source.read();
    advance(4 * 60_000);
    await source.read();
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(57 * 60_000);
    const [later] = await source.read();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(later?.stale).toBe(true);
    expect(later?.fetchedAt).toBe(new Date(NOW).toISOString());
  });

  it('reads the key only when a request is due, and says once that it is missing', async () => {
    const env: Record<string, string | undefined> = {};
    const { source, fetch, logs, advance } = setup({ env });
    expect(await source.read()).toEqual([]);
    advance(5 * 60_000);
    await source.read();
    expect(fetch).not.toHaveBeenCalled();
    expect(logs).toEqual(['quota fetch (DeepSeek): DEEPSEEK_API_KEY is not set']);
    env.DEEPSEEK_API_KEY = KEY;
    advance(5 * 60_000);
    expect(await source.read()).toHaveLength(1);
    expect(logs.at(-1)).toBe('quota fetch (DeepSeek): working again');
  });

  it('keeps the last balance through a failure and never logs the key', async () => {
    let status = 200;
    const { source, logs, advance } = setup({
      respond: () =>
        status === 200
          ? Response.json(balanceBody(['CNY', '12.30']))
          : Response.json({ error: { message: `bad key ${KEY}` } }, { status }),
    });
    const [good] = await source.read();
    status = 401;
    advance(5 * 60_000);
    const [after] = await source.read();
    expect(after).toEqual(good);
    expect(logs).toEqual(['quota fetch (DeepSeek): the balance endpoint answered HTTP 401']);
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('ignores a body it cannot read as a balance', async () => {
    const { source, logs } = setup({ respond: () => Response.json({ is_available: false }) });
    expect(await source.read()).toEqual([]);
    expect(logs).toEqual([
      'quota fetch (DeepSeek): the balance endpoint answered in an unknown format',
    ]);
  });
});
