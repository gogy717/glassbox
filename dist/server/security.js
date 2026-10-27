import { randomBytes, timingSafeEqual } from 'node:crypto';
import { TOKEN_HEADER } from '../shared/protocol.js';
import { jsonResponse } from './json.js';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * The checks from the security model in `src/shared/protocol.ts`. Transcripts are sensitive
 * even read-only: without the Host check a DNS-rebinding page could read them all, and the
 * token keeps other pages from starting runs through a simple cross-site POST.
 */
export function createSecurity() {
    const token = randomBytes(32).toString('hex');
    const expected = Buffer.from(token);
    const middleware = async (c, next) => {
        const deny = (error) => jsonResponse(c, { error }, 403);
        // Headers are the client's word; the socket is not. Without this, a non-browser client on
        // the LAN could send `Host: localhost` to a server bound to 0.0.0.0.
        const peer = remoteAddress(c.env);
        if (peer !== undefined && !isLoopbackAddress(peer))
            return deny('glassbox only answers requests from this machine');
        // Node always has a Host header; the URL fallback only matters for in-process requests,
        // whose URL is built from the Host header by @hono/node-server anyway.
        const host = c.req.header('host') ?? new URL(c.req.url).host;
        if (!isLoopbackHost(host))
            return deny('forbidden host');
        const origin = c.req.header('origin');
        if (origin !== undefined && !isLoopbackOrigin(origin))
            return deny('forbidden origin');
        if (MUTATING.has(c.req.method)) {
            const given = Buffer.from(c.req.header(TOKEN_HEADER) ?? '');
            if (given.length !== expected.length || !timingSafeEqual(given, expected))
                return deny('missing or wrong token');
        }
        await next();
    };
    return { token, middleware };
}
/** The TCP peer of a request served by @hono/node-server; undefined for in-process requests. */
function remoteAddress(env) {
    const bindings = env?.server ?? env;
    return bindings?.incoming
        ?.socket?.remoteAddress;
}
function isLoopbackAddress(address) {
    const a = address.toLowerCase();
    return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}
/**
 * Sent on every response. The UI fetches its own token, so a page that framed it could
 * overlay it and trick a click on "allow" in a permission prompt: no framing at all, and no
 * script, connection or form target other than this origin.
 */
export const SECURITY_HEADERS = {
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        // React's style attributes need inline styles; no inline script is ever allowed.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
};
/** Adds SECURITY_HEADERS to whatever response the rest of the app produced. */
export const securityHeaders = async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
        c.res.headers.set(name, value);
};
function isLoopbackHost(host) {
    let url;
    try {
        url = new URL(`http://${host}`);
    }
    catch {
        return false;
    }
    // Reject anything that is more than host[:port], e.g. "evil@localhost" or "localhost/x".
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
        return false;
    return LOOPBACK.has(url.hostname);
}
function isLoopbackOrigin(origin) {
    try {
        const url = new URL(origin);
        // Like the Host check: a real Origin never carries credentials, e.g. "http://evil@localhost".
        if (url.username || url.password)
            return false;
        return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK.has(url.hostname);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=security.js.map