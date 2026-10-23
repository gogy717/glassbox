import { describe, expect, it, vi } from 'vitest';
import { createQuotaFetcher, USAGE_URL } from './quota-fetch.js';

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const TOKEN = 'sk-ant-oat-secret-fixture';

const credentials = (oauth: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: TOKEN,
      refreshToken: 'refresh-secret',
      expiresAt: NOW + 60 * 60_000,
      ...oauth,
    },
  });

const usageBody = {
  five_hour: { utilization: 12, resets_at: '2026-10-23T05:00:00.000Z' },
  seven_day: { utilization: 34, resets_at: '2026-10-26T00:00:00.000Z' },
};

function setup(
  opts: {
    creds?: string | null;
    platform?: NodeJS.Platform;
    keychain?: string | null;
    respond?: () => Response | Promise<Response>;
  } = {},
) {
  let now = NOW;
  const logs: string[] = [];
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      opts.respond?.() ?? Response.json(usageBody),
  );
  const fetcher = createQuotaFetcher({
    claudeDir: '/home/u/.claude',
    intervalMs: 5 * 60_000,
    platform: opts.platform ?? 'linux',
    fetch: fetch as unknown as typeof globalThis.fetch,
    readText: async (path) => {
      expect(path).toBe('/home/u/.claude/.credentials.json');
      const creds = opts.creds === undefined ? credentials() : opts.creds;
      if (creds === null) throw new Error('ENOENT');
      return creds;
    },
    keychain: async () => {
      if (opts.keychain == null) throw new Error('not found');
      return opts.keychain;
    },
    now: () => now,
    log: (m) => logs.push(m),
  });
  return { fetcher, fetch, logs, advance: (ms: number) => (now += ms) };
}

describe('createQuotaFetcher', () => {
  it('asks the usage endpoint with the Claude Code sign-in', async () => {
    const { fetcher, fetch } = setup();
    const quota = await fetcher.latest();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(USAGE_URL);
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'anthropic-beta': 'oauth-2025-04-20',
    });
    expect(quota).toMatchObject({
      source: 'anthropic-usage-api',
      fetchedAt: new Date(NOW).toISOString(),
      stale: false,
      windows: [
        { id: 'five_hour', usedPercent: 12 },
        { id: 'seven_day', usedPercent: 34 },
      ],
    });
  });

  it('asks at most once per interval, and turns stale with age', async () => {
    const { fetcher, fetch, advance } = setup();
    await fetcher.latest();
    advance(4 * 60_000);
    await fetcher.latest();
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(60_000);
    await fetcher.latest();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent reads', async () => {
    const { fetcher, fetch } = setup();
    await Promise.all([fetcher.latest(), fetcher.latest()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never uses or refreshes an expired token', async () => {
    const { fetcher, fetch, logs } = setup({ creds: credentials({ expiresAt: NOW + 30_000 }) });
    expect(await fetcher.latest()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(logs).toEqual([expect.stringContaining('expired')]);
  });

  it('is quiet about a missing sign-in after saying so once', async () => {
    const { fetcher, fetch, logs, advance } = setup({ creds: null });
    await fetcher.latest();
    advance(10 * 60_000);
    await fetcher.latest();
    expect(fetch).not.toHaveBeenCalled();
    expect(logs).toEqual(['quota fetch: no Claude Code sign-in found']);
  });

  it('reads the macOS Keychain when there is no credentials file', async () => {
    const { fetcher, fetch } = setup({ creds: null, platform: 'darwin', keychain: credentials() });
    expect(await fetcher.latest()).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the last quota through a failure and never logs the token', async () => {
    let status = 200;
    const { fetcher, logs, advance } = setup({
      respond: () => (status === 200 ? Response.json(usageBody) : new Response('{}', { status })),
    });
    const good = await fetcher.latest();
    status = 429;
    advance(5 * 60_000);
    const after = await fetcher.latest();
    expect(after?.fetchedAt).toBe(good?.fetchedAt);
    expect(after?.stale).toBe(false);
    status = 200;
    advance(5 * 60_000);
    await fetcher.latest();
    expect(logs).toEqual([
      'quota fetch: the usage endpoint answered HTTP 429',
      'quota fetch: working again',
    ]);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('ignores a body it cannot read as a quota', async () => {
    const { fetcher, logs } = setup({ respond: () => Response.json({ error: 'nope' }) });
    expect(await fetcher.latest()).toBeNull();
    expect(logs).toEqual(['quota fetch: the usage endpoint answered in an unknown format']);
  });

  it('reports a network failure without throwing', async () => {
    const { fetcher, logs } = setup({
      respond: () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    });
    expect(await fetcher.latest()).toBeNull();
    expect(logs).toEqual(['quota fetch: request failed (getaddrinfo ENOTFOUND)']);
  });
});
