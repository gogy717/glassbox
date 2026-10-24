import { describe, expect, it, vi } from 'vitest';
import { type Attempt, getJson, periodicFetch } from './periodic-fetch.js';

const NOW = Date.parse('2026-10-23T04:00:00.000Z');

function setup(attempt: () => Promise<Attempt<number>>) {
  let now = NOW;
  const logs: string[] = [];
  const spy = vi.fn(attempt);
  const loop = periodicFetch({
    attempt: spy,
    name: 'quota fetch (Test)',
    intervalMs: 5 * 60_000,
    log: (m) => logs.push(m),
    now: () => now,
  });
  return { loop, attempt: spy, logs, advance: (ms: number) => (now += ms) };
}

describe('periodicFetch', () => {
  it('asks at most once per interval and stamps the answer with its time', async () => {
    const { loop, attempt, advance } = setup(async () => ({ ok: 1 }));
    expect(await loop.latest()).toEqual({ value: 1, fetchedAtMs: NOW });
    advance(4 * 60_000);
    await loop.latest();
    expect(attempt).toHaveBeenCalledTimes(1);
    advance(60_000);
    await loop.latest();
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent reads', async () => {
    const { loop, attempt } = setup(async () => ({ ok: 1 }));
    await Promise.all([loop.latest(), loop.latest()]);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('keeps the last answer through failures and logs each streak once', async () => {
    let next: Attempt<number> = { ok: 1 };
    const { loop, logs, advance } = setup(async () => next);
    await loop.latest();
    next = { problem: 'the endpoint answered HTTP 503' };
    for (let i = 0; i < 3; i++) {
      advance(5 * 60_000);
      expect(await loop.latest()).toEqual({ value: 1, fetchedAtMs: NOW });
    }
    next = { ok: 2 };
    advance(5 * 60_000);
    expect((await loop.latest())?.value).toBe(2);
    expect(logs).toEqual([
      'quota fetch (Test): the endpoint answered HTTP 503',
      'quota fetch (Test): working again',
    ]);
  });

  it("keeps the last failure's kind for the UI until a request works", async () => {
    let next: Attempt<number> = { problem: 'the sign-in has expired', reason: 'sign-in-expired' };
    const { loop, advance } = setup(async () => next);
    expect(loop.problem()).toBeNull();
    await loop.latest();
    expect(loop.problem()).toBe('sign-in-expired');
    next = { problem: 'the endpoint answered HTTP 503' };
    advance(5 * 60_000);
    await loop.latest();
    expect(loop.problem()).toBe('fetch-failed');
    next = { ok: 1 };
    advance(5 * 60_000);
    await loop.latest();
    expect(loop.problem()).toBeNull();
  });

  it('logs a rejected attempt by error name only, never its message', async () => {
    const { loop, logs } = setup(async () => {
      throw new SyntaxError('Unexpected token in "secret-token-fixture"');
    });
    expect(await loop.latest()).toBeNull();
    expect(logs).toEqual(['quota fetch (Test): failed (SyntaxError)']);
    expect(loop.problem()).toBe('fetch-failed');
  });
});

describe('getJson', () => {
  const call = (respond: () => Response | Promise<Response>) => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respond());
    const result = getJson(
      fetch as unknown as typeof globalThis.fetch,
      'https://api.example.com/usage',
      { Authorization: 'Bearer secret-token-fixture' },
      'secret-token-fixture',
      'the usage endpoint',
    );
    return { fetch, result };
  };

  it('refuses redirects and sets a timeout', async () => {
    const { fetch, result } = call(() => Response.json({ a: 1 }));
    expect(await result).toEqual({ ok: { a: 1 } });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports an HTTP error by status, without its body', async () => {
    const { result } = call(() => new Response('{"error":"secret detail"}', { status: 401 }));
    expect(await result).toEqual({ problem: 'the usage endpoint answered HTTP 401' });
  });

  it('reports a body that is not JSON', async () => {
    const { result } = call(() => new Response('<html>'));
    expect(await result).toEqual({ problem: 'the usage endpoint did not answer JSON' });
  });

  it('reports a network failure with its cause, the secret cut out', async () => {
    const { result } = call(() => {
      throw new TypeError('fetch failed', {
        cause: new Error('getaddrinfo ENOTFOUND for secret-token-fixture'),
      });
    });
    expect(await result).toEqual({
      problem: 'request failed (fetch failed: getaddrinfo ENOTFOUND for …)',
    });
  });

  it('reports a timeout in words', async () => {
    const { result } = call(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    expect(await result).toEqual({ problem: 'request failed (no answer within 10 s)' });
  });
});
