import { describe, expect, it, vi } from 'vitest';
import { BILLING_URL, billingWindows, createXaiQuotaSource, tokenFrom } from './quota-fetch.js';

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const TOKEN = 'xai-grok-token-secret-fixture';
const EMAIL = 'someone@example.com';
const USER_ID = '00000000-0000-4000-8000-000000000001';

/** Grok CLI's `auth.json`: one entry per sign-in, keyed by issuer and client id (synthetic). */
const authJson = (entry: Record<string, unknown> = {}) =>
  JSON.stringify({
    'https://auth.x.ai::00000000-0000-4000-8000-0000000000aa': {
      key: TOKEN,
      auth_mode: 'oidc',
      create_time: '2026-10-23T01:00:00.000Z',
      user_id: USER_ID,
      email: EMAIL,
      first_name: 'Some',
      last_name: 'One',
      refresh_token: 'refresh-secret-fixture',
      expires_at: new Date(NOW + 3 * 60 * 60_000).toISOString(),
      oidc_issuer: 'https://auth.x.ai',
      ...entry,
    },
  });

/** The shape `GET /v1/billing?format=credits` answers for a weekly plan, synthetic numbers. */
const billingBody = {
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-10-18T07:31:55.424+00:00',
      end: '2026-10-25T07:31:55.424+00:00',
    },
    creditUsagePercent: 25,
    productUsage: [
      { product: 'GrokBot', usagePercent: 16 },
      { product: 'GrokBuild', usagePercent: 9 },
    ],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    billingPeriodStart: '2026-10-18T07:31:55.424+00:00',
    billingPeriodEnd: '2026-10-25T07:31:55.424+00:00',
  },
};

const RESETS = '2026-10-25T07:31:55.424Z';

function setup(opts: { auth?: string | null; respond?: () => Response | Promise<Response> } = {}) {
  let now = NOW;
  const logs: string[] = [];
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      opts.respond?.() ?? Response.json(billingBody),
  );
  const source = createXaiQuotaSource({
    grokDir: '/home/u/.grok',
    intervalMs: 5 * 60_000,
    fetch: fetch as unknown as typeof globalThis.fetch,
    readText: async (path) => {
      expect(path).toBe('/home/u/.grok/auth.json');
      const auth = opts.auth === undefined ? authJson() : opts.auth;
      if (auth === null) throw new Error('ENOENT');
      return auth;
    },
    now: () => now,
    log: (m) => logs.push(m),
  });
  return { source, fetch, logs, advance: (ms: number) => (now += ms) };
}

describe('billingWindows', () => {
  it('reads the weekly credits and each product share', () => {
    expect(billingWindows(billingBody)).toEqual([
      {
        id: 'credits:1w',
        kind: 'weekly',
        label: 'SuperGrok Weekly Credits',
        model: null,
        usedPercent: 25,
        resetsAt: RESETS,
      },
      {
        id: 'product:grokbot:1w',
        kind: 'weekly',
        label: 'GrokBot (Weekly)',
        model: null,
        usedPercent: 16,
        resetsAt: RESETS,
      },
      {
        id: 'product:grokbuild:1w',
        kind: 'weekly',
        label: 'Grok Build (Weekly)',
        model: null,
        usedPercent: 9,
        resetsAt: RESETS,
      },
    ]);
  });

  it('counts an unused product as 0 and skips numbers out of range', () => {
    const windows = billingWindows({
      config: {
        ...billingBody.config,
        creditUsagePercent: 140,
        productUsage: [{ product: 'Api' }, { product: 'GrokBot', usagePercent: 'x' }, {}],
      },
    });
    expect(windows.map((w) => [w.id, w.label, w.usedPercent])).toEqual([
      ['product:api:1w', 'API (Weekly)', 0],
    ]);
  });

  it('finds nothing without a weekly period', () => {
    expect(billingWindows({ code: 16, message: 'unauthenticated' })).toEqual([]);
    expect(
      billingWindows({
        config: { ...billingBody.config, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY' } },
      }),
    ).toEqual([]);
  });
});

describe('tokenFrom', () => {
  it('takes the sign-in that expires last', () => {
    const text = JSON.stringify({
      a: { key: 'older', expires_at: new Date(NOW + 60 * 60_000).toISOString() },
      b: { key: 'newer', expires_at: new Date(NOW + 2 * 60 * 60_000).toISOString() },
      c: { auth_mode: 'oidc' },
    });
    expect(tokenFrom(text, NOW)).toEqual({ token: 'newer' });
  });

  it('says why there is no token without quoting the file', () => {
    expect(tokenFrom(`{"x": "${TOKEN}`, NOW)).toEqual({
      missing: 'the Grok sign-in is not valid JSON',
    });
    expect(tokenFrom('{}', NOW)).toEqual({ missing: 'not signed in to Grok (`grok login`)' });
  });
});

describe('createXaiQuotaSource', () => {
  it('asks the billing endpoint with the Grok CLI sign-in', async () => {
    const { source, fetch } = setup();
    expect(source.id).toBe('xai-api');
    const [quota] = await source.read();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(BILLING_URL);
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      'X-XAI-Token-Auth': 'xai-grok-cli',
    });
    expect(init?.redirect).toBe('error');
    expect(quota).toMatchObject({
      provider: 'xai',
      agent: 'grok',
      plan: null,
      fetchedAt: new Date(NOW).toISOString(),
      stale: false,
      extraUsage: null,
      balance: null,
      source: 'xai-api',
    });
    expect(quota?.windows.map((w) => w.usedPercent)).toEqual([25, 16, 9]);
    // Nothing about the account leaves the sign-in file.
    const json = JSON.stringify(quota);
    for (const secret of [TOKEN, EMAIL, USER_ID, 'Some']) expect(json).not.toContain(secret);
  });

  it('asks at most once per interval, and turns stale with age', async () => {
    const { source, fetch, advance } = setup();
    await source.read();
    advance(4 * 60_000);
    await source.read();
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(60_000);
    await source.read();
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockImplementation(async () => new Response('', { status: 503 }));
    advance(61 * 60_000);
    const [old] = await source.read();
    expect(old?.stale).toBe(true);
  });

  it('never uses or refreshes an expired token', async () => {
    const { source, fetch, logs } = setup({
      auth: authJson({ expires_at: new Date(NOW + 30_000).toISOString() }),
    });
    expect(await source.read()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(logs).toEqual([expect.stringContaining('expired')]);
  });

  it('is quiet about a missing sign-in after saying so once', async () => {
    const { source, fetch, logs, advance } = setup({ auth: null });
    await source.read();
    advance(10 * 60_000);
    await source.read();
    expect(fetch).not.toHaveBeenCalled();
    expect(logs).toEqual(['quota fetch (xAI): no Grok sign-in found']);
  });

  it('keeps the last quota through a failure and never logs the token', async () => {
    let status = 200;
    const { source, logs, advance } = setup({
      respond: () =>
        status === 200 ? Response.json(billingBody) : new Response(TOKEN, { status }),
    });
    const [good] = await source.read();
    status = 401;
    advance(5 * 60_000);
    const [after] = await source.read();
    expect(after).toEqual(good);
    status = 200;
    advance(5 * 60_000);
    await source.read();
    expect(logs).toEqual([
      'quota fetch (xAI): the billing endpoint answered HTTP 401',
      'quota fetch (xAI): working again',
    ]);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('ignores a body it cannot read as a quota', async () => {
    const { source, logs } = setup({ respond: () => Response.json({ config: {} }) });
    expect(await source.read()).toEqual([]);
    expect(logs).toEqual(['quota fetch (xAI): the billing endpoint answered in an unknown format']);
  });
});
