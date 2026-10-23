import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchRequestDetail, fetchToolResult } from './api';

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches request detail from the protocol URL', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ requestId: 'r/1' })));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchRequestDetail('claude-code:s', 'r/1')).resolves.toEqual({ requestId: 'r/1' });
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/claude-code%3As/requests/r%2F1/detail',
      expect.anything(),
    );
  });

  it('rejects with the server error message on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 })),
    );
    const p = fetchToolResult('s', 't');
    await expect(p).rejects.toBeInstanceOf(ApiError);
    await expect(p).rejects.toMatchObject({ status: 404, message: 'not found' });
  });
});
