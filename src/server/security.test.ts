import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { TOKEN_HEADER } from '../shared/protocol.js';
import { createSecurity } from './security.js';

function guarded() {
  const security = createSecurity();
  const app = new Hono();
  app.use('/api/*', security.middleware);
  app.get('/api/thing', (c) => c.json({ ok: true }));
  app.post('/api/thing', (c) => c.json({ ok: true }));
  app.delete('/api/thing', (c) => c.json({ ok: true }));
  return { app, token: security.token };
}

const get = (app: Hono, headers: Record<string, string>) => app.request('/api/thing', { headers });

describe('createSecurity', () => {
  it('makes a fresh 32-byte hex token per launch', () => {
    const a = createSecurity().token;
    const b = createSecurity().token;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it.each([
    'localhost',
    'localhost:7788',
    '127.0.0.1:7788',
    '127.0.0.1',
    '[::1]:7788',
    'LOCALHOST:5173',
  ])('accepts Host %s', async (host) => {
    const { app } = guarded();
    expect((await get(app, { host })).status).toBe(200);
  });

  it.each([
    'evil.example',
    'evil.example:7788',
    '127.0.0.1.evil.example',
    'localhost.evil.example:7788',
    '192.168.1.20:7788',
    '0.0.0.0:7788',
    'not a host',
    'evil.example@localhost:7788',
    'localhost:7788/x',
  ])('rejects Host %s (DNS rebinding)', async (host) => {
    const { app } = guarded();
    const res = await get(app, { host });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.stringContaining('host') });
  });

  it.each(['http://localhost:5173', 'http://127.0.0.1:7788', 'http://[::1]:7788'])(
    'accepts Origin %s',
    async (origin) => {
      const { app } = guarded();
      expect((await get(app, { host: '127.0.0.1:7788', origin })).status).toBe(200);
    },
  );

  it.each([
    'https://evil.example',
    'http://localhost.evil.example',
    'null',
    'garbage',
    'http://evil.com@localhost',
    'http://a:b@127.0.0.1:7788',
  ])('rejects Origin %s', async (origin) => {
    const { app } = guarded();
    const res = await get(app, { host: '127.0.0.1:7788', origin });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.stringContaining('origin') });
  });

  it('requires the token on mutating requests', async () => {
    const { app, token } = guarded();
    const host = '127.0.0.1:7788';
    for (const method of ['POST', 'DELETE']) {
      const none = await app.request('/api/thing', { method, headers: { host } });
      expect(none.status).toBe(403);
      expect(await none.json()).toEqual({ error: expect.stringContaining('token') });
      // Same length, last character changed (never equal to the token itself).
      const wrongToken = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
      const wrong = await app.request('/api/thing', {
        method,
        headers: { host, [TOKEN_HEADER]: wrongToken },
      });
      expect(wrong.status).toBe(403);
      const short = await app.request('/api/thing', {
        method,
        headers: { host, [TOKEN_HEADER]: 'abc' },
      });
      expect(short.status).toBe(403);
      const ok = await app.request('/api/thing', {
        method,
        headers: { host, [TOKEN_HEADER]: token },
      });
      expect(ok.status).toBe(200);
    }
  });

  it('does not require the token on reads', async () => {
    const { app } = guarded();
    expect((await get(app, { host: 'localhost:7788' })).status).toBe(200);
  });

  it('never adds CORS headers', async () => {
    const { app } = guarded();
    const res = await get(app, { host: 'localhost:7788', origin: 'http://localhost:5173' });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('remote address', () => {
  // What @hono/node-server passes as env: the Node request, whose socket knows the peer.
  const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

  it.each(['192.168.1.20', '10.0.0.7', '::ffff:192.168.1.20', 'fe80::1'])(
    'refuses a request from %s even with a loopback Host header',
    async (address) => {
      const { app } = guarded();
      const res = await app.request(
        '/api/thing',
        { headers: { host: 'localhost:7788', origin: 'http://localhost:7788' } },
        peer(address),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: expect.stringContaining('this machine') });
    },
  );

  it.each(['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1'])(
    'accepts a request from %s',
    async (address) => {
      const { app } = guarded();
      const res = await app.request(
        '/api/thing',
        { headers: { host: 'localhost:7788' } },
        peer(address),
      );
      expect(res.status).toBe(200);
    },
  );
});
